/* dsx-accounts - Analyst accounts for The Draft Stock Exchange (Analyst Desk).
 *
 * Sign in with Google or Discord, pick an analyst name, rank a class, save it.
 * Stores NO email, NO password, NO real name: only the provider's account number,
 * the analyst name the user picks, their boards, and timestamps.
 *
 * Bindings (Cloudflare dashboard > Worker > Settings):
 *   DB                     D1 database "dsx-accounts-db"   (required)
 *   GOOGLE_CLIENT_ID       variable                        (required for Google)
 *   GOOGLE_CLIENT_SECRET   secret                          (required for Google)
 *   DISCORD_CLIENT_ID      variable                        (required for Discord)
 *   DISCORD_CLIENT_SECRET  secret                          (required for Discord)
 *   IP_SALT                secret, any long random string  (recommended)
 *   OWNER_IDS              variable, comma-separated user ids allowed to take reserved names (Cory)
 * Custom domain: api.thedraftstockexchange.com  (same site as the board, so the
 *   session cookie is first-party).  Cron (optional): "17 9 * * *" cleans up.
 *
 * Endpoints (JSON unless noted; every non-GET needs an allowed Origin)
 *   GET    /status
 *   GET    /auth/<google|discord>/start?return=<site url>   -> 302 to the provider
 *   GET    /auth/<google|discord>/callback                  -> 302 back to the site (#desk)
 *   POST   /auth/logout
 *   GET    /me                 -> {user:null} | {user:{name,since,providers}, boards:[...], classes:{...}}
 *   POST   /me/name  {name}    -> set / change analyst name
 *   DELETE /me                 -> delete the account and everything in it
 *   GET    /boards/<year>      -> {year, status, lockAt, boards:[{slot,name,main,picks,updated}], picks, updated}
 *                                  (top-level picks/updated = the MAIN board, for pages cached before the 3-board update)
 *   PUT    /boards/<year>/<1-3> {picks?, name?, main?}  -> create or update that board (up to 3 per class)
 *   DELETE /boards/<year>/<1-3>
 *   PUT    /boards/<year> {picks}  -> old single-board call: saves the MAIN board
 *
 * Boards: each analyst gets up to MAX_BOARDS named boards per class. Exactly one is the MAIN board (starred);
 * only the MAIN board counts for the scorecard / leaderboard once the class locks. Board names: 1-30 chars,
 * unique within that analyst's boards for the class.
 *
 * Class status: OPEN_CLASSES can be saved until that class's lock time
 * (class_lock table: INSERT INTO class_lock(year,lock_at) VALUES(2027, <ms>)).
 * After the lock: read-only ("locked").
 */

const SITE_ORIGINS = ['https://thedraftstockexchange.com', 'https://www.thedraftstockexchange.com'];
const OPEN_CLASSES = [2027];           // phase 1: the 2027 board only
const MIN_PICKS_SCORED = 10;           // shown in the UI; scoring is phase 2
const SESSION_DAYS = 90;
const STATE_MAX_AGE = 10 * 60 * 1000;  // an OAuth round trip must finish inside 10 minutes
const SAVES_PER_HOUR = 300;
const MAX_BOARDS = 3;                  // named boards per analyst per class (Nov 6 2026)
const NEW_ACCOUNTS_PER_NET_DAY = 40;      // high on purpose: phone carriers put many people behind one IP
const ROSTER = {"2013":{"NOEL":[1,"Nerlens Noel",0],"PORT":[2,"Otto Porter Jr.",0],"OLAD":[3,"Victor Oladipo",0],"MCLE":[4,"Ben McLemore",0],"LENA":[5,"Alex Len",0],"BENN":[6,"Anthony Bennett",0],"BURK":[7,"Trey Burke",0],"MCCO":[8,"CJ McCollum",0],"CART":[9,"Michael Carter-Williams",0],"CALD":[10,"Kentavious Caldwell-Pope",0],"ADAM":[11,"Steven Adams",0],"ZELL":[12,"Cody Zeller",0],"LARK":[13,"Shane Larkin",0],"OLYN":[14,"Kelly Olynyk",0],"MUHA":[15,"Shabazz Muhammad",0],"GOBE":[16,"Rudy Gobert",0],"ANTE":[17,"Giannis Antetokounmpo",0],"DIEN":[18,"Gorgui Dieng",0],"SCHR":[19,"Dennis Schroder",0],"KARA":[20,"Sergey Karasev",0],"PLUM":[21,"Mason Plumlee",0],"HARD":[25,"Tim Hardaway Jr.",0],"BULL":[27,"Reggie Bullock",0],"NOGU":[28,"Lucas Nogueira",0],"SNEL":[30,"Tony Snell",0],"GOOD":[32,"Archie Goodwin",0],"JEAN":[39,"Livio Jean-Charles",0],"HILL":[44,"Solomon Hill",0],"NEDO":[47,"Nemanja Nedovic",0],"ROBE":[50,"Andre Roberson",0],"KELL":[53,"Ryan Kelly",0]},"2014":{"WIGG":[1,"Andrew Wiggins",0],"PARK":[2,"Jabari Parker",0],"EMBI":[3,"Joel Embiid",0],"EXUM":[4,"Dante Exum",0],"VONL":[5,"Noah Vonleh",0],"SMAR":[6,"Marcus Smart",0],"GORD":[7,"Aaron Gordon",0],"RAND":[8,"Julius Randle",0],"MCDE":[9,"Doug McDermott",0],"STAU":[10,"Nik Stauskas",0],"PAYT":[11,"Elfrid Payton",0],"LAVI":[12,"Zach LaVine",0],"HARR":[13,"Gary Harris",0],"NURK":[14,"Jusuf Nurkic",0],"YOUN":[15,"James Young",0],"ENNI":[16,"Tyler Ennis",0],"SARI":[17,"Dario Saric",0],"ANDE":[18,"Kyle Anderson",0],"HOOD":[19,"Rodney Hood",0],"NAPI":[20,"Shabazz Napier",0],"PAYN":[21,"Adreian Payne",0],"WARR":[22,"T.J. Warren",0],"HAIR":[23,"P.J. Hairston",0],"CAPE":[24,"Clint Capela",0],"MCGA":[25,"Mitch McGary",0],"ADAM":[26,"Jordan Adams",0],"GRAN":[30,"Jerami Grant",0],"CLAR":[32,"Jordan Clarkson",0],"BOGD":[34,"Bogdan Bogdanovic",0],"WILC":[36,"C.J. Wilcox",0],"JOKI":[40,"Nikola Jokic",0],"HUES":[48,"Josh Huestis",0],"CABO":[53,"Bruno Caboclo",0],"POWE":[54,"Dwight Powell",0]},"2015":{"TOWN":[1,"Karl-Anthony Towns",0],"OKAF":[2,"Jahlil Okafor",0],"RUSS":[3,"D'Angelo Russell",0],"PORZ":[4,"Kristaps Porzingis",0],"WINS":[5,"Justise Winslow",0],"MUDI":[6,"Emmanuel Mudiay",0],"HEZO":[7,"Mario Hezonja",0],"CAUL":[8,"Willie Cauley-Stein",0],"JOHN":[9,"Stanley Johnson",0],"KAMI":[10,"Frank Kaminsky",0],"TURN":[11,"Myles Turner",0],"BOOK":[12,"Devin Booker",0],"PAYN":[13,"Cameron Payne",0],"LYLE":[14,"Trey Lyles",0],"OUBR":[15,"Kelly Oubre Jr.",0],"PORT":[16,"Bobby Portis",0],"DEKK":[17,"Sam Dekker",0],"GRAN":[18,"Jerian Grant",0],"JONE":[19,"Tyus Jones",0],"LOON":[20,"Kevon Looney",0],"HUNT":[21,"R.J. Hunter",0],"WRIG":[22,"Delon Wright",0],"HOLL":[23,"Rondae Hollis-Jefferson",0],"VAUG":[25,"Rashad Vaughn",0],"ANDE":[26,"Justin Anderson",0],"ROZI":[27,"Terry Rozier",0],"MCCU":[28,"Chris McCullough",0],"MART":[30,"Jarell Martin",0],"MILU":[42,"Nikola Milutinov",0],"CONN":[44,"Pat Connaughton",0],"POWE":[45,"Norman Powell",0],"RICH":[46,"Josh Richardson",0],"NANC":[47,"Larry Nance Jr.",0]},"2016":{"SIMM":[1,"Ben Simmons",0],"INGR":[2,"Brandon Ingram",0],"DUNN":[3,"Kris Dunn",0],"BEND":[4,"Dragan Bender",0],"MURR":[5,"Jamal Murray",0],"BROW":[6,"Jaylen Brown",0],"POEL":[7,"Jakob Poeltl",0],"ELLE":[8,"Henry Ellenson",0],"LABI":[9,"Skal Labissiere",0],"HIEL":[10,"Buddy Hield",0],"SABO":[11,"Domantas Sabonis",0],"CHRI":[14,"Marquese Chriss",0],"VALE":[15,"Denzel Valentine",0],"BEMB":[16,"DeAndre' Bembry",0],"LUWA":[17,"Timothe Luwawu-Cabarrot",0],"KORK":[19,"Furkan Korkmaz",0],"BALD":[20,"Wade Baldwin",0],"PRIN":[21,"Taurean Prince",0],"BEAS":[22,"Malik Beasley",0],"JOHN":[23,"Brice Johnson",0],"ZIZI":[24,"Ante Zizic",0],"RICH":[25,"Malachi Richardson",0],"MUR1":[27,"Dejounte Murray",0],"LEVE":[28,"Caris LeVert",0],"MCCA":[29,"Patrick McCaw",0],"JONE":[30,"Damian Jones",0],"ZUBA":[31,"Ivica Zubac",0],"HERN":[32,"Juancho Hernangomez",0],"ULIS":[34,"Tyler Ulis",0],"MAKE":[36,"Thon Maker",0],"SIAK":[40,"Pascal Siakam",0],"PAPA":[42,"Georgios Papagiannis",0],"BROG":[44,"Malcolm Brogdon",0],"YABU":[48,"Guerschon Yabusele",0],"NIAN":[49,"Georges Niang",0]},"2017":{"FULT":[1,"Markelle Fultz",0],"BALL":[2,"Lonzo Ball",0],"JACK":[3,"Josh Jackson",0],"FOXD":[4,"De'Aaron Fox",0],"TATU":[5,"Jayson Tatum",0],"ISAA":[6,"Jonathan Isaac",0],"SMIT":[7,"Dennis Smith Jr.",0],"MONK":[8,"Malik Monk",0],"MARK":[9,"Lauri Markkanen",0],"NTIL":[10,"Frank Ntilikina",0],"COLL":[11,"Zach Collins",0],"MITC":[12,"Donovan Mitchell",0],"JAC1":[13,"Justin Jackson",0],"PATT":[14,"Justin Patton",0],"COL1":[15,"John Collins",0],"KENN":[16,"Luke Kennard",0],"GILE":[17,"Harry Giles",0],"LEAF":[18,"T.J. Leaf",0],"ALLE":[19,"Jarrett Allen",0],"FERG":[20,"Terrance Ferguson",0],"ADEB":[21,"Bam Adebayo",0],"HAR1":[22,"Isaiah Hartenstein",0],"SWAN":[24,"Caleb Swanigan",0],"HART":[25,"Josh Hart",0],"ANUN":[26,"OG Anunoby",0],"LYDO":[29,"Tyler Lydon",0],"WHIT":[32,"Derrick White",0],"BRAD":[35,"Tony Bradley",0],"KUZM":[36,"Kyle Kuzma",0],"WILS":[38,"D.J. Wilson",0],"PASE":[39,"Anzejs Pasecniks",0],"BROO":[46,"Dillon Brooks",0]},"2018":{"DONC":[1,"Luka Doncic",0],"JACK":[2,"Jaren Jackson Jr.",0],"AYTO":[3,"Deandre Ayton",0],"BAGL":[4,"Marvin Bagley III",0],"BAMB":[5,"Mo Bamba",0],"CART":[6,"Wendell Carter Jr.",0],"PORT":[7,"Michael Porter Jr.",0],"YOUN":[8,"Trae Young",0],"BRID":[9,"Mikal Bridges",0],"BRI1":[10,"Miles Bridges",0],"KNOX":[11,"Kevin Knox",0],"SEXT":[12,"Collin Sexton",0],"WILL":[13,"Robert Williams",0],"GILG":[14,"Shai Gilgeous-Alexander",0],"WALK":[15,"Lonnie Walker IV",0],"SMIT":[16,"Zhaire Smith",0],"ROB1":[17,"Mitchell Robinson",0],"BROW":[18,"Troy Brown Jr.",0],"MUSA":[19,"Dzanan Musa",0],"EVAN":[20,"Jacob Evans",0],"HUER":[21,"Kevin Huerter",0],"BRUN":[22,"Jalen Brunson",0],"HOLI":[23,"Aaron Holiday",0],"OKOG":[24,"Josh Okogie",0],"ALLE":[25,"Grayson Allen",0],"HUTC":[26,"Chandler Hutchison",0],"DIVI":[29,"Donte DiVincenzo",0],"SIMO":[30,"Anfernee Simons",0],"MELT":[32,"De'Anthony Melton",0],"SHAM":[36,"Landry Shamet",0],"ROBI":[37,"Jerome Robinson",0],"WAGN":[42,"Moritz Wagner",0],"SPEL":[43,"Omari Spellman",0]},"2019":{"WILL":[1,"Zion Williamson",0],"MORA":[2,"Ja Morant",0],"BARR":[3,"RJ Barrett",0],"CULV":[4,"Jarrett Culver",0],"HUNT":[5,"De'Andre Hunter",0],"HAYE":[6,"Jaxson Hayes",0],"REDD":[7,"Cam Reddish",0],"GARL":[8,"Darius Garland",0],"CLAR":[9,"Brandon Clarke",0],"LITT":[10,"Nassir Little",0],"LANG":[11,"Romeo Langford",0],"ALEX":[12,"Nickeil Alexander-Walker",0],"WIL1":[13,"Grant Williams",0],"WHIT":[14,"Coby White",0],"DOUM":[15,"Sekou Doumbouya",0],"PORT":[17,"Kevin Porter Jr.",0],"WASH":[18,"P.J. Washington",0],"BITA":[19,"Goga Bitadze",0],"HACH":[20,"Rui Hachimura",0],"HERR":[21,"Tyler Herro",0],"JOH1":[23,"Keldon Johnson",0],"JOHN":[26,"Cameron Johnson",0],"OKEK":[27,"Chuma Okeke",0],"JERO":[28,"Ty Jerome",0],"THYB":[29,"Matisse Thybulle",0],"SAMA":[31,"Luka Samanic",0],"KABE":[32,"Mfiondu Kabengele",0],"GAFF":[33,"Daniel Gafford",0],"WIND":[34,"Dylan Windler",0],"CLAX":[37,"Nic Claxton",0],"PASC":[38,"Eric Paschall",0],"BAZL":[39,"Darius Bazley",0],"POOL":[41,"Jordan Poole",0]},"2020":{"BALL":[1,"LaMelo Ball",0],"EDWA":[2,"Anthony Edwards",0],"WISE":[3,"James Wiseman",0],"OKON":[4,"Onyeka Okongwu",0],"AVDI":[5,"Deni Avdija",0],"TOPP":[6,"Obi Toppin",0],"HALI":[7,"Tyrese Haliburton",0],"OKOR":[8,"Isaac Okoro",0],"HAYE":[9,"Killian Hayes",0],"VASS":[10,"Devin Vassell",0],"LEWI":[11,"Kira Lewis Jr.",0],"WILL":[12,"Patrick Williams",0],"HAMP":[13,"R.J. Hampton",0],"MAXE":[14,"Tyrese Maxey",0],"BEYS":[15,"Saddiq Bey",0],"NESM":[16,"Aaron Nesmith",0],"ANTH":[17,"Cole Anthony",0],"POKU":[18,"Aleksej Pokusevski",0],"ACHI":[19,"Precious Achiuwa",0],"SMIT":[20,"Jalen Smith",0],"GREE":[21,"Josh Green",0],"BANE":[23,"Desmond Bane",0],"BOLM":[24,"Leandro Bolmaro",0],"MCDA":[26,"Jaden McDaniels",0],"FLYN":[27,"Malachi Flynn",0],"NNAJ":[28,"Zeke Nnaji",0],"STEW":[30,"Isaiah Stewart",0],"JONE":[33,"Tre Jones",0],"PRIT":[38,"Payton Pritchard",0],"REED":[39,"Paul Reed",0],"QUIC":[40,"Immanuel Quickley",0],"AZUB":[48,"Udoka Azubuike",0]},"2021":{"CUNN":[1,"Cade Cunningham",0],"MOBL":[2,"Evan Mobley",0],"GREE":[3,"Jalen Green",0],"SUGG":[4,"Jalen Suggs",0],"KUMI":[5,"Jonathan Kuminga",0],"BARN":[6,"Scottie Barnes",0],"GIDD":[7,"Josh Giddey",0],"WAGN":[8,"Franz Wagner",0],"MOOD":[9,"Moses Moody",0],"BOUK":[10,"James Bouknight",0],"JOH1":[11,"Keon Johnson",0],"SENG":[12,"Alperen Sengun",0],"KISP":[13,"Corey Kispert",0],"MITC":[14,"Davion Mitchell",0],"JONE":[15,"Kai Jones",0],"JOHN":[16,"Jalen Johnson",0],"GARU":[17,"Usman Garuba",0],"DUAR":[18,"Chris Duarte",0],"JACK":[20,"Isaiah Jackson",0],"MURP":[21,"Trey Murphy III",0],"SPRI":[22,"Jaden Springer",0],"WILL":[23,"Ziaire Williams",0],"MANN":[24,"Tre Mann",0],"THOM":[25,"Cam Thomas",0],"SHAR":[28,"Day'Ron Sharpe",0],"HYLA":[29,"Bones Hyland",0],"DOSU":[30,"Ayo Dosunmu",0],"CHRI":[31,"Josh Christopher",0],"PRIM":[32,"Joshua Primo",0],"GRIM":[37,"Quentin Grimes",0],"JON1":[39,"Herbert Jones",0],"QUET":[46,"Neemias Queta",0],"ALDA":[47,"Santi Aldama",0],"WIGG":[52,"Aaron Wiggins",0],"MAMU":[53,"Sandro Mamukelashvili",0]},"2022":{"SMIT":[1,"Jabari Smith Jr.",0],"HOLM":[2,"Chet Holmgren",0],"BANC":[3,"Paolo Banchero",0],"IVEY":[4,"Jaden Ivey",0],"MATH":[5,"Bennedict Mathurin",0],"SHAR":[6,"Shaedon Sharpe",0],"MURR":[7,"Keegan Murray",0],"GRIF":[8,"AJ Griffin",0],"DAVI":[9,"Johnny Davis",0],"DANI":[10,"Dyson Daniels",0],"DURE":[11,"Jalen Duren",0],"SOCH":[12,"Jeremy Sochan",0],"EASO":[13,"Tari Eason",0],"DIEN":[14,"Ousmane Dieng",0],"WIL1":[15,"Mark Williams",0],"AGBA":[16,"Ochai Agbaji",0],"JOVI":[17,"Nikola Jovic",0],"WESL":[18,"Blake Wesley",0],"WASH":[20,"TyTy Washington Jr.",0],"BEAU":[22,"MarJon Beauchamp",0],"KESS":[23,"Walker Kessler",0],"BRAN":[24,"Malaki Branham",0],"WILL":[25,"Jalen Williams",0],"MOOR":[27,"Wendell Moore Jr.",0],"BALD":[28,"Patrick Baldwin Jr.",0],"LARA":[30,"Jake LaRavia",0],"CHRI":[33,"Max Christie",0],"BRAU":[34,"Christian Braun",0],"WATS":[35,"Peyton Watson",0],"TERR":[36,"Dalen Terry",0],"NEMB":[37,"Andrew Nembhard",0],"RODD":[41,"David Roddy",0],"ROLL":[45,"Ryan Rollins",0],"DIAB":[53,"Moussa Diabate",0]},"2023":{"WEMB":[1,"Victor Wembanyama",0],"SCOO":[2,"Scoot Henderson",0],"BMIL":[3,"Brandon Miller",0],"AMEN":[4,"Amen Thompson",0],"AUSR":[5,"Ausar Thompson",0],"JWLK":[6,"Jarace Walker",0],"WHIT":[7,"Cam Whitmore",0],"ABLK":[8,"Anthony Black",0],"THEN":[9,"Taylor Hendricks",0],"LIVE":[10,"Dereck Lively II",0],"GDIK":[11,"Gradey Dick",0],"COUL":[12,"Bilal Coulibaly",0],"JHSC":[13,"Jalen Hood-Schifino",0],"HAWK":[14,"Jordan Hawkins",0],"BUFK":[15,"Kobe Bufkin",0],"CWAL":[16,"Cason Wallace",0],"KGRG":[17,"Keyonte George",0],"KMUR":[18,"Kris Murray",0],"LMIL":[19,"Leonard Miller",0],"NSMI":[20,"Nick Smith Jr.",0],"JHOW":[21,"Jett Howard",0],"JAQZ":[22,"Jaime Jaquez Jr.",0],"DWHD":[23,"Dariq Whitehead",0],"SENS":[24,"Brice Sensabaugh",0],"CLOW":[25,"Noah Clowney",0],"PROS":[26,"Olivier-Maxence Prosper",0],"PODZ":[27,"Brandin Podziemski",0],"BSHP":[28,"Ben Sheppard",0],"GGJK":[35,"GG Jackson II",0],"SASS":[36,"Marcus Sasser",0],"KBRN":[37,"Kobe Brown",0],"STRW":[39,"Julian Strawther",0],"TJDV":[41,"Trayce Jackson-Davis",0],"CAMA":[55,"Toumani Camara",0]},"2024":{"SARR":[1,"Alex Sarr",0],"RISA":[2,"Zaccharie Risacher",0],"CLNG":[3,"Donovan Clingan",0],"SHEP":[4,"Reed Sheppard",0],"CSTL":[5,"Stephon Castle",0],"HOLL":[6,"Ron Holland II",0],"BUZL":[7,"Matas Buzelis",0],"TOPC":[8,"Nikola Topic",0],"DILL":[9,"Rob Dillingham",0],"DCAR":[10,"Devin Carter",0],"KNEC":[11,"Dalton Knecht",0],"CWIL":[12,"Cody Williams",0],"SALA":[13,"Tidjane Salaün",0],"CARR":[14,"Bub Carrington",0],"MCAI":[15,"Jared McCain",0],"COLL":[16,"Isaiah Collier",0],"EDEY":[17,"Zach Edey",0],"FLIP":[18,"Kyle Filipowski",0],"MISS":[19,"Yves Missi",0],"WALT":[20,"Ja'Kobe Walter",0],"WARE":[21,"Kel'el Ware",0],"DSIL":[22,"Tristan da Silva",0],"HOLM":[23,"DaRon Holmes II",0],"DUNN":[25,"Ryan Dunn",0],"KGEO":[26,"Kyshawn George",0],"SCHR":[29,"Baylor Scheierman",0],"TYSN":[30,"Jaylon Tyson",0],"SHAN":[31,"Terrence Shannon Jr.",0],"DADI":[33,"Pacôme Dadiet",0],"AJJO":[35,"AJ Johnson",0],"MITC":[39,"Ajay Mitchell",0],"DJON":[40,"Dillon Jones",0],"IGHO":[42,"Oso Ighodaro",0],"WELL":[47,"Jaylen Wells",0],"SPEN":[51,"Cam Spencer",0],"LARS":[52,"Pelle Larsson",0]},"2025":{"FLAG":[1,"Cooper Flagg",0],"DHRP":[2,"Dylan Harper",0],"VJED":[3,"VJ Edgecombe",0],"KNUE":[4,"Kon Knueppel",0],"ACEB":[5,"Ace Bailey",0],"TREJ":[6,"Tre Johnson",0],"QUEN":[7,"Derik Queen",0],"FEAR":[8,"Jeremiah Fears",0],"KMAL":[9,"Khaman Maluach",0],"CMBY":[10,"Collin Murray-Boyles",0],"ESSG":[11,"Noa Essengue",0],"JAKU":[12,"Kasparas Jakučionis",0],"CWRD":[13,"Cedric Coward",0],"CBRY":[14,"Carter Bryant",0],"SORB":[15,"Thomas Sorber",0],"DEMN":[16,"Egor Demin",0],"NCLF":[17,"Nique Clifford",0],"JRIC":[18,"Jase Richardson",0],"WCLA":[19,"Walter Clayton Jr.",0],"BRNG":[20,"Joan Beringer",0],"NEWL":[21,"Asa Newell",0],"TRAO":[22,"Nolan Traoré",0],"WOLF":[23,"Danny Wolf",0],"FLEM":[24,"Rasheer Fleming",0],"MCNE":[25,"Liam McNeeley",0],"SARF":[26,"Ben Saraf",0],"KALK":[27,"Ryan Kalkbrenner",0],"HUGO":[29,"Hugo González",0],"RILY":[30,"Will Riley",0],"RAYN":[31,"Maxime Raynaud",0],"POWL":[33,"Drake Powell",0],"YANG":[34,"Yang Hansen",0],"YKNI":[38,"Yanic Konan Niederhäuser",0],"JAME":[47,"Sion James",0],"SAND":[52,"Kobe Sanders",0]},"2026":{"CBZR":[1,"Cameron Boozer",0],"DPTR":[2,"Darryn Peterson",0],"DYBN":[3,"AJ Dybantsa",0],"CWIL":[4,"Caleb Wilson",0],"ACUF":[5,"Darius Acuff Jr.",0],"WGLR":[6,"Keaton Wagler",0],"MBJR":[7,"Mikel Brown Jr.",0],"KFLM":[8,"Kingston Flemings",0],"BURR":[9,"Brayden Burries",0],"MARA":[10,"Aday Mara",0],"MREZ":[11,"Morez Johnson Jr.",0],"YXLB":[12,"Yaxel Lendeborg",0],"AMNT":[13,"Nate Ament",0],"PHLN":[14,"LaBaron Philon Jr.",0],"STNB":[15,"Hannes Steinbach",0],"CAND":[16,"Christian Anderson Jr.",0],"OKOR":[17,"Ebuka Okorie",0],"STRZ":[18,"Bennett Stirtz",0],"KLPZ":[19,"Karim Lopez",0],"CARR":[20,"Cameron Carr",0],"SWAN":[21,"Dailyn Swain",0],"CNAC":[22,"Chris Cenac Jr.",0],"GRVS":[23,"Allen Graves",0],"QUNT":[24,"Jayden Quaintance",0],"DELA":[25,"Sergio De Larrea",0],"EVNS":[26,"Isaiah Evans",0],"PEAT":[27,"Koa Peat",0],"MLKT":[28,"Meleek Thomas",0],"TRDR":[29,"Tarris Reed Jr.",0],"ZUBY":[30,"Zuby Ejiofor",0],"HVEE":[31,"Henri Veesaar",0],"AKAR":[32,"Alex Karaban",0],"JJEF":[33,"Joshua Jefferson",0],"THRN":[34,"Bruce Thornton",0],"RCON":[35,"Ryan Conwell",0],"BMIL":[36,"Baba Miller",0],"RSAU":[37,"Richie Saunders",0],"ESHP":[39,"Emanuel Sharp",0],"BRAZ":[42,"Trevon Brazile",0]},"2027":{"STOK":[1,"Tyran Stokes",0],"SMTH":[2,"Jordan Smith Jr.",0],"HOLT":[3,"Caleb Holt",0],"BRNC":[4,"Bruce Branch III",0],"JOKS":[5,"Stefan Joksimovic",0],"MULN":[6,"Braylon Mullins",0],"THMP":[7,"Anthony Thompson",0],"HAUG":[8,"Thomas Haugh",0],"ALLN":[9,"Amari Allen",0],"KRIV":[10,"Motiejus Krivas",0],"NGON":[11,"Patrick Ngongba II",0],"KHAR":[12,"Ivan Kharchenkov",0],"CROW":[13,"Jason Crowe Jr.",0],"COLE":[14,"Quentin Coleman",0],"CWLM":[15,"Cameron Williams",0],"AREN":[16,"Alijah Arenas",0],"SUIG":[17,"Luigi Suigo",0],"YIMG":[18,"Hugo Yimga-Moukouri",0],"MCOY":[19,"Brandon McCoy Jr.",0],"LNDR":[20,"Colben Landrew",0],"MNGO":[21,"Dylan Mingo",0],"YESS":[22,"Tounde Yessoufou",0],"MIRK":[23,"David Mirkovic",0],"BRIC":[24,"Billy Richmond III",0],"MUUR":[25,"Miikka Muurinen",0],"FOGL":[26,"Davis Fogle",0],"ABLE":[27,"Matt Able",0],"TOUR":[28,"Abdou Toure",0],"MORN":[29,"Malachi Moreno",0],"GASK":[30,"Caleb Gaskins",0],"ANDR":[31,"JJ Andrews",0],"DSAR":[32,"Dame Sarr",0],"MCKN":[33,"Trey McKenney Jr.",0],"OLAD":[34,"Baba Oladotun",0],"TANR":[35,"Tyler Tanner",0],"EKEZ":[36,"Obinna Ekezie Jr.",0],"GOOS":[37,"Austin Goosby",0],"VAAK":[38,"Stefan Vaaks",0],"COND":[39,"Alex Condon",0],"CCOL":[40,"Christian Collins",0],"DANI":[41,"Dash Daniels",0],"CHIN":[42,"Rueben Chinyelu",0],"HINE":[43,"Najai Hines",0],"MOMC":[44,"Milan Momčilović",0],"HARR":[45,"Juke Harris",0],"HOUI":[46,"Cameron Houindo",1],"KEIT":[47,"Sayon Keita",1],"SNFT":[48,"Pryce Sandfort",1],"HOWD":[49,"Bryson Howard",1],"DIOP":[50,"Massamba Diop",1]}};             // {year:{TKR:[consensus rank, name, otc]}}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT, name_key TEXT, created INTEGER NOT NULL, renamed INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_name_key ON users(name_key)`,
  `CREATE TABLE IF NOT EXISTS identities(provider TEXT NOT NULL, sub TEXT NOT NULL, user_id TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(provider, sub))`,
  `CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, seen INTEGER)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS oauth_state(state TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT, ret TEXT, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS boards(user_id TEXT NOT NULL, year INTEGER NOT NULL, picks TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(user_id, year))`,
  `CREATE TABLE IF NOT EXISTS boards3(user_id TEXT NOT NULL, year INTEGER NOT NULL, slot INTEGER NOT NULL, name TEXT NOT NULL, main INTEGER NOT NULL DEFAULT 0, picks TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(user_id, year, slot))`,
  // carry phase-1 boards over (idempotent; the old table is emptied right after, and a newer old-table write still wins)
  `INSERT INTO boards3(user_id,year,slot,name,main,picks,created,updated) SELECT user_id, year, 1, 'My Board', 1, picks, created, updated FROM boards WHERE true
     ON CONFLICT(user_id,year,slot) DO UPDATE SET picks=excluded.picks, updated=excluded.updated WHERE excluded.updated > boards3.updated`,
  `DELETE FROM boards`,
  `CREATE TABLE IF NOT EXISTS class_lock(year INTEGER PRIMARY KEY, lock_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ratelimit(k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)`,
];
let ready = null;
function init(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { ready = null; throw e; });
  return ready;
}

/* ---------- helpers ---------- */
const now = () => Date.now();
const dev = env => env.DEV === '1';
function siteOriginOk(o, env) {
  if (!o) return false;
  if (SITE_ORIGINS.includes(o)) return true;
  if (/^https:\/\/[a-z0-9-]+\.cory-grebe\.workers\.dev$/.test(o)) return true;     // the site's preview URLs
  return dev(env) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}
function cors(req, env) {
  const o = req.headers.get('Origin');
  if (!siteOriginOk(o, env)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
function json(req, env, obj, status = 200, extra = {}) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req, env) });
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'Set-Cookie') [].concat(v).forEach(c => h.append('Set-Cookie', c)); else h.set(k, v);
  }
  return new Response(JSON.stringify(obj), { status, headers: h });
}
function redirect(url, cookies = []) {
  const h = new Headers({ Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  cookies.forEach(c => h.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers: h });
}
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function randToken(n = 32) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64u(a); }
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256b64u(s) { return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
function cookies(req) {
  const out = {};
  (req.headers.get('Cookie') || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
function cookie(name, value, maxAge, path = '/') {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
async function netHash(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'none';
  return (await sha256hex((env.IP_SALT || 'dsx-accounts') + '|' + new Date().toISOString().slice(0, 10) + '|' + ip)).slice(0, 24);
}
/* fixed-window counter; returns false once the limit is passed */
async function limit(env, key, max, windowMs) {
  const t = now();
  const row = await env.DB.prepare('SELECT n, exp FROM ratelimit WHERE k=?').bind(key).first();
  if (!row || row.exp < t) { await env.DB.prepare('INSERT OR REPLACE INTO ratelimit(k,n,exp) VALUES(?,1,?)').bind(key, t + windowMs).run(); return true; }
  if (row.n >= max) return false;
  await env.DB.prepare('UPDATE ratelimit SET n=n+1 WHERE k=?').bind(key).run();
  return true;
}

/* ---------- analyst names ---------- */
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{1,18})[A-Za-z0-9]$/;
const RESERVED = ['admin', 'administrator', 'moderator', 'mod', 'dsx', 'dse', 'dhj', 'demas', 'demasthehoopjunkie', 'hoopjunkie',
  'thedraftstockexchange', 'draftstockexchange', 'official', 'staff', 'support', 'system', 'claude', 'anthropic', 'nba', 'market', 'null', 'undefined'];
// substrings that are never innocent, and words only blocked as a whole word (so Analyst, Hancock, Sussex, Scunthorpe pass)
const BAD = ['fuck', 'shit', 'cunt', 'nigg', 'kike', 'retard', 'whore', 'slut', 'hitler', 'nazi', 'porn', 'jizz', 'tranny', 'wetback', 'kkk', 'faggot', 'bitch'];
const BAD_WORD = ['anal', 'anus', 'sex', 'cum', 'dick', 'cock', 'coon', 'spic', 'rape', 'rapist', 'fag', 'fags', 'pussy', 'penis', 'vagina', 'chink', 'tits', 'boobs', 'dildo', 'hoe', 'hoes', 'nig'];
const nameKey = n => n.toLowerCase().replace(/[ ._-]/g, '');
function nameProblem(n, owner) {
  if (typeof n !== 'string') return 'Pick an analyst name.';
  n = n.trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(n)) return 'Use 3-20 letters, numbers, spaces, dots, dashes or underscores, starting and ending with a letter or number.';
  const k = nameKey(n);
  // reserved names (DSX / DHJ / Demas...) are kept for the site owner: OWNER_IDS = comma-separated user ids (Worker variable)
  if (!owner && RESERVED.some(r => k === r || (r.length > 4 && k.includes(r)))) return 'That name is reserved.';
  if (dirty(n)) return 'Pick a different name.';
  return null;
}

function dirty(n) {
  const k = nameKey(n), leet = k.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/\$/g, 's');
  const words = n.toLowerCase().split(/[^a-z0-9]+/).concat(n.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).map(w => w.toLowerCase()));
  return BAD.some(b => k.includes(b) || leet.includes(b)) || words.some(w => BAD_WORD.includes(w));
}
const BOARD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 .,'&#()\/!?+_-]{0,29}$/;
function boardNameProblem(n) {
  if (typeof n !== 'string') return 'Give the board a name.';
  n = n.trim().replace(/\s+/g, ' ');
  if (!BOARD_NAME_RE.test(n)) return 'Board names are 1-30 characters: letters, numbers, spaces and simple punctuation, starting with a letter or number.';
  if (dirty(n)) return 'Pick a different board name.';
  return null;
}
const cleanBoardName = n => n.trim().replace(/\s+/g, ' ');

/* ---------- sessions ---------- */
async function currentUser(req, env) {
  const tok = cookies(req).dsx_s;
  if (!tok || !/^[A-Za-z0-9_-]{30,80}$/.test(tok)) return null;
  const hash = await sha256hex(tok);
  const row = await env.DB.prepare('SELECT s.user_id, s.expires, s.seen, u.name, u.created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=?').bind(hash).first();
  if (!row) return null;
  const t = now();
  if (row.expires < t) { await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(hash).run(); return null; }
  if (!row.seen || t - row.seen > 24 * 3600e3) {   // sliding expiry, written at most once a day
    await env.DB.prepare('UPDATE sessions SET seen=?, expires=? WHERE hash=?').bind(t, t + SESSION_DAYS * 864e5, hash).run();
  }
  return { id: row.user_id, name: row.name, created: row.created, hash };
}
async function newSession(env, userId) {
  const tok = randToken(32), t = now();
  await env.DB.prepare('INSERT INTO sessions(hash,user_id,created,expires,seen) VALUES(?,?,?,?,?)')
    .bind(await sha256hex(tok), userId, t, t + SESSION_DAYS * 864e5, t).run();
  return cookie('dsx_s', tok, SESSION_DAYS * 86400);
}

/* ---------- OAuth providers ---------- */
function providers(env) {
  const g = {
    id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, pkce: true,
    auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scope: 'openid', extra: { prompt: 'select_account' },
  };
  const d = {
    id: env.DISCORD_CLIENT_ID, secret: env.DISCORD_CLIENT_SECRET, pkce: false,
    auth: 'https://discord.com/oauth2/authorize', token: 'https://discord.com/api/oauth2/token',
    me: 'https://discord.com/api/users/@me', scope: 'identify', extra: {},
  };
  if (dev(env) && env.MOCK_OAUTH) {               // tests only: a local mock provider
    for (const [p, o] of [['google', g], ['discord', d]]) {
      o.auth = env.MOCK_OAUTH + '/' + p + '/authorize'; o.token = env.MOCK_OAUTH + '/' + p + '/token';
      if (o.me) o.me = env.MOCK_OAUTH + '/' + p + '/me';
    }
  }
  return { google: g, discord: d };
}
function returnUrl(raw, env) {
  try {
    const u = new URL(raw);
    if (siteOriginOk(u.origin, env)) return u.origin + u.pathname + (u.search || '') + '#desk';
  } catch (_) {}
  return SITE_ORIGINS[0] + '/#desk';
}
async function authStart(req, env, url, prov) {
  const P = providers(env)[prov];
  if (!P || !P.id || !P.secret) return new Response('Sign-in with ' + prov + ' is not set up yet.', { status: 503 });
  const t = now();
  await env.DB.prepare('DELETE FROM oauth_state WHERE created < ?').bind(t - 3600e3).run();
  const state = randToken(24), verifier = P.pkce ? randToken(48) : null;
  const ret = returnUrl(url.searchParams.get('return') || '', env);
  await env.DB.prepare('INSERT INTO oauth_state(state,provider,verifier,ret,created) VALUES(?,?,?,?,?)').bind(state, prov, verifier, ret, t).run();
  const q = new URLSearchParams({ client_id: P.id, redirect_uri: url.origin + '/auth/' + prov + '/callback', response_type: 'code', scope: P.scope, state, ...P.extra });
  if (P.pkce) { q.set('code_challenge', await sha256b64u(verifier)); q.set('code_challenge_method', 'S256'); }
  // the state is also pinned to this browser, so a sign-in link someone else started can't log you into their account
  return redirect(P.auth + '?' + q.toString(), [cookie('dsx_st', state, 600, '/auth/')]);
}
function decodeJwtPayload(jwt) {
  const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(p + '==='.slice((p.length + 3) % 4)))));
}
async function authCallback(req, env, url, prov) {
  const P = providers(env)[prov];
  const fail = (ret, why) => redirect(ret.replace(/#desk$/, '#desk?err=' + why), [cookie('dsx_st', '', 0, '/auth/')]);
  const state = url.searchParams.get('state') || '';
  const row = state ? await env.DB.prepare('SELECT * FROM oauth_state WHERE state=?').bind(state).first() : null;
  if (row) await env.DB.prepare('DELETE FROM oauth_state WHERE state=?').bind(state).run();
  const ret = row ? row.ret : SITE_ORIGINS[0] + '/#desk';
  if (!P || !row || row.provider !== prov || now() - row.created > STATE_MAX_AGE || cookies(req).dsx_st !== state) return fail(ret, 'expired');
  if (url.searchParams.get('error')) return fail(ret, 'cancelled');
  const code = url.searchParams.get('code');
  if (!code) return fail(ret, 'cancelled');

  let sub = null;
  try {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: url.origin + '/auth/' + prov + '/callback', client_id: P.id, client_secret: P.secret });
    if (P.pkce) body.set('code_verifier', row.verifier);
    const tr = await fetch(P.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    if (!tr.ok) return fail(ret, 'provider');
    const tk = await tr.json();
    if (prov === 'google') {
      // the ID token came straight from Google's token endpoint over TLS, so its issuer is already proven
      // (OpenID Connect Core 3.1.3.7); we still check who it was issued to
      const c = decodeJwtPayload(tk.id_token || '');
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(c.iss) && !(dev(env) && c.iss === 'mock')) return fail(ret, 'provider');
      if (c.aud !== P.id || !(c.exp * 1000 > now())) return fail(ret, 'provider');
      sub = String(c.sub || '');
    } else {
      const mr = await fetch(P.me, { headers: { Authorization: 'Bearer ' + tk.access_token } });
      if (!mr.ok) return fail(ret, 'provider');
      sub = String((await mr.json()).id || '');
    }
  } catch (e) { return fail(ret, 'provider'); }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sub)) return fail(ret, 'provider');

  let ident = await env.DB.prepare('SELECT user_id FROM identities WHERE provider=? AND sub=?').bind(prov, sub).first();
  let userId = ident && ident.user_id;
  if (!userId) {
    if (!(await limit(env, 'new:' + await netHash(req, env), NEW_ACCOUNTS_PER_NET_DAY, 864e5))) return fail(ret, 'busy');
    userId = randToken(12);
    const t = now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users(id,name,name_key,created) VALUES(?,NULL,NULL,?)').bind(userId, t),
      env.DB.prepare('INSERT INTO identities(provider,sub,user_id,created) VALUES(?,?,?,?)').bind(prov, sub, userId, t),
    ]);
  }
  return redirect(ret, [await newSession(env, userId), cookie('dsx_st', '', 0, '/auth/')]);
}

/* ---------- classes / boards ---------- */
async function classInfo(env) {
  const locks = {};
  const rs = await env.DB.prepare('SELECT year, lock_at FROM class_lock').all();
  (rs.results || []).forEach(r => { locks[r.year] = r.lock_at; });
  const out = {}, t = now();
  OPEN_CLASSES.forEach(y => {
    const L = locks[y] || null;
    out[y] = { status: L && t >= L ? 'locked' : 'open', lockAt: L, players: Object.keys(ROSTER[y] || {}).length, minScored: MIN_PICKS_SCORED };
  });
  return out;
}
async function userBoards(env, uid, year) {
  const rs = await env.DB.prepare('SELECT slot, name, main, picks, updated FROM boards3 WHERE user_id=? AND year=? ORDER BY slot').bind(uid, year).all();
  return (rs.results || []).map(r => ({ slot: r.slot, name: r.name, main: !!r.main, picks: JSON.parse(r.picks), updated: r.updated }));
}
function boardsOut(year, boards, info) {
  const m = boards.find(b => b.main) || null;
  return { year, status: info ? info.status : 'closed', lockAt: info ? info.lockAt : null, max: MAX_BOARDS, boards,
    picks: m ? m.picks : [], updated: m ? m.updated : null };
}
function cleanPicks(year, picks) {
  const R = ROSTER[year];
  if (!R || !Array.isArray(picks)) return null;
  if (picks.length > Object.keys(R).length) return null;
  const seen = new Set();
  for (const p of picks) {
    if (typeof p !== 'string' || !Object.prototype.hasOwnProperty.call(R, p) || seen.has(p)) return null;
    seen.add(p);
  }
  return picks;
}

/* ---------- router ---------- */
async function handle(req, env) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/', m = req.method;
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
  await init(env);

  if (path === '/status') {
    const u = await env.DB.prepare('SELECT COUNT(*) n FROM users').first();
    const b = await env.DB.prepare('SELECT COUNT(*) n FROM boards3').first();
    const P = providers(env);
    return json(req, env, { ok: true, users: u.n, boards: b.n, google: !!(P.google.id && P.google.secret), discord: !!(P.discord.id && P.discord.secret), classes: await classInfo(env) });
  }
  let a;
  if ((a = /^\/auth\/(google|discord)\/(start|callback)$/.exec(path)) && m === 'GET') {
    return a[2] === 'start' ? authStart(req, env, url, a[1]) : authCallback(req, env, url, a[1]);
  }

  // everything below is the signed-in API: writes must come from the site
  if (m !== 'GET' && !siteOriginOk(req.headers.get('Origin'), env)) return json(req, env, { error: 'origin' }, 403);

  if (path === '/auth/logout' && m === 'POST') {
    const tok = cookies(req).dsx_s;
    if (tok) await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(await sha256hex(tok)).run();
    return json(req, env, { ok: true }, 200, { 'Set-Cookie': cookie('dsx_s', '', 0) });
  }

  const user = await currentUser(req, env);
  const classes = await classInfo(env);
  if (path === '/me' && m === 'GET') {
    if (!user) return json(req, env, { user: null, classes });
    const ids = await env.DB.prepare('SELECT provider FROM identities WHERE user_id=?').bind(user.id).all();
    const bs = await env.DB.prepare('SELECT year, slot, name, main, picks, updated FROM boards3 WHERE user_id=? ORDER BY year DESC, slot').bind(user.id).all();
    return json(req, env, {
      user: { name: user.name, since: user.created, providers: (ids.results || []).map(r => r.provider) },
      boards: (bs.results || []).map(r => ({ year: r.year, slot: r.slot, name: r.name, main: !!r.main, count: JSON.parse(r.picks).length, updated: r.updated })),
      classes,
    });
  }
  if (!user) return json(req, env, { error: 'signin' }, 401);

  if (path === '/me/name' && m === 'POST') {
    let body; try { body = await req.json(); } catch (_) { return json(req, env, { error: 'bad' }, 400); }
    const owner = String(env.OWNER_IDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(user.id);
    const why = nameProblem(body && body.name, owner);
    if (why) return json(req, env, { error: 'name', message: why }, 400);
    const name = body.name.trim().replace(/\s+/g, ' '), key = nameKey(name);
    if (!(await limit(env, 'name:' + user.id, 10, 864e5))) return json(req, env, { error: 'busy', message: 'Too many name changes today.' }, 429);
    const taken = await env.DB.prepare('SELECT id FROM users WHERE name_key=?').bind(key).first();
    if (taken && taken.id !== user.id) return json(req, env, { error: 'name', message: 'That analyst name is taken.' }, 409);
    try { await env.DB.prepare('UPDATE users SET name=?, name_key=?, renamed=? WHERE id=?').bind(name, key, now(), user.id).run(); }
    catch (e) { return json(req, env, { error: 'name', message: 'That analyst name is taken.' }, 409); }
    return json(req, env, { ok: true, name });
  }
  if (path === '/me' && m === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM boards WHERE user_id=?').bind(user.id),
      env.DB.prepare('DELETE FROM boards3 WHERE user_id=?').bind(user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
      env.DB.prepare('DELETE FROM identities WHERE user_id=?').bind(user.id),
      env.DB.prepare('DELETE FROM users WHERE id=?').bind(user.id),
    ]);
    return json(req, env, { ok: true, deleted: true }, 200, { 'Set-Cookie': cookie('dsx_s', '', 0) });
  }
  if ((a = /^\/boards\/(20\d\d)(?:\/(\d))?$/.exec(path))) {
    const year = +a[1], info = classes[year], slotArg = a[2] ? +a[2] : null;
    if (slotArg !== null && (slotArg < 1 || slotArg > MAX_BOARDS)) return json(req, env, { error: 'notfound' }, 404);
    if (m === 'GET') return json(req, env, boardsOut(year, await userBoards(env, user.id, year), info));
    if (!info) return json(req, env, { error: 'closed', message: 'Boards for this class are not open.' }, 403);
    if (!user.name) return json(req, env, { error: 'noname', message: 'Pick an analyst name first.' }, 409);
    if (!(await limit(env, 'save:' + user.id, SAVES_PER_HOUR, 3600e3))) return json(req, env, { error: 'busy', message: 'Too many saves this hour. Try again shortly.' }, 429);
    const locked = info.status !== 'open';
    const lockedRes = () => json(req, env, { error: 'locked', message: 'This class is locked. Boards are frozen as of the draft.' }, 423);
    const boards = await userBoards(env, user.id, year);
    const t = now();
    if (m === 'PUT') {
      const len = +(req.headers.get('Content-Length') || 0);
      if (len > 8192) return json(req, env, { error: 'bad' }, 413);
      let body; try { body = await req.json(); } catch (_) { return json(req, env, { error: 'bad' }, 400); }
      if (!body || typeof body !== 'object') return json(req, env, { error: 'bad' }, 400);
      // old single-board call (pages cached before the update): it means "my MAIN board"
      const slot = slotArg !== null ? slotArg : ((boards.find(x => x.main) || boards[0] || { slot: 1 }).slot);
      const cur = boards.find(x => x.slot === slot);
      const wantPicks = body.picks !== undefined, wantName = body.name !== undefined, wantMain = body.main === true;
      if (!wantPicks && !wantName && !wantMain) return json(req, env, { error: 'bad' }, 400);
      if (locked && (wantPicks || wantMain || !cur)) return lockedRes();
      let picks = null;
      if (wantPicks) {
        picks = cleanPicks(year, body.picks);
        if (!picks) return json(req, env, { error: 'bad', message: 'That board has a player who is not in this class, or a duplicate.' }, 400);
      }
      let name = null;
      if (wantName) {
        const why = boardNameProblem(body.name);
        if (why) return json(req, env, { error: 'boardname', message: why }, 400);
        name = cleanBoardName(body.name);
      }
      if (!cur) {
        if (boards.length >= MAX_BOARDS) return json(req, env, { error: 'full', message: 'You already have ' + MAX_BOARDS + ' boards for this class. Delete one first.' }, 409);
        if (!name) { name = slot === 1 && !boards.some(x => x.name.toLowerCase() === 'my board') ? 'My Board' : 'Board ' + slot; }
      }
      if (name && boards.some(x => x.slot !== slot && x.name.toLowerCase() === name.toLowerCase()))
        return json(req, env, { error: 'boardname', message: 'You already have a board called "' + name + '".' }, 409);
      const stmts = [];
      if (!cur) {
        const main = boards.length === 0 || wantMain ? 1 : 0;
        if (main && boards.length) stmts.push(env.DB.prepare('UPDATE boards3 SET main=0 WHERE user_id=? AND year=?').bind(user.id, year));
        stmts.push(env.DB.prepare('INSERT INTO boards3(user_id,year,slot,name,main,picks,created,updated) VALUES(?,?,?,?,?,?,?,?)')
          .bind(user.id, year, slot, name, main, JSON.stringify(picks || []), t, t));
      } else {
        if (picks) stmts.push(env.DB.prepare('UPDATE boards3 SET picks=?, updated=? WHERE user_id=? AND year=? AND slot=?').bind(JSON.stringify(picks), t, user.id, year, slot));
        if (name) stmts.push(env.DB.prepare('UPDATE boards3 SET name=? WHERE user_id=? AND year=? AND slot=?').bind(name, user.id, year, slot));
        if (wantMain && !cur.main) {
          stmts.push(env.DB.prepare('UPDATE boards3 SET main=0 WHERE user_id=? AND year=?').bind(user.id, year));
          stmts.push(env.DB.prepare('UPDATE boards3 SET main=1 WHERE user_id=? AND year=? AND slot=?').bind(user.id, year, slot));
        }
      }
      if (stmts.length) await env.DB.batch(stmts);
      const out = boardsOut(year, await userBoards(env, user.id, year), info);
      out.board = out.boards.find(x => x.slot === slot) || null;
      out.saved = t;
      return json(req, env, out);
    }
    if (m === 'DELETE' && slotArg !== null) {
      const cur = boards.find(x => x.slot === slotArg);
      if (!cur) return json(req, env, boardsOut(year, boards, info));
      if (locked) return lockedRes();
      const stmts = [env.DB.prepare('DELETE FROM boards3 WHERE user_id=? AND year=? AND slot=?').bind(user.id, year, slotArg)];
      const rest = boards.filter(x => x.slot !== slotArg);
      if (cur.main && rest.length) stmts.push(env.DB.prepare('UPDATE boards3 SET main=1 WHERE user_id=? AND year=? AND slot=?').bind(user.id, year, rest[0].slot));
      await env.DB.batch(stmts);
      return json(req, env, boardsOut(year, await userBoards(env, user.id, year), info));
    }
  }
  return json(req, env, { error: 'notfound' }, 404);
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { console.error(e && e.stack || e); return json(req, env, { error: 'server' }, 500); }
  },
  async scheduled(ev, env) {
    await init(env);
    const t = now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(t),
      env.DB.prepare('DELETE FROM oauth_state WHERE created < ?').bind(t - 3600e3),
      env.DB.prepare('DELETE FROM ratelimit WHERE exp < ?').bind(t),
    ]);
  },
};
