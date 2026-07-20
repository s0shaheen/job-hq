"""US metro resolution for geo-first searches (city/state -> metro name).

Why this exists: a country filter is the right grain for a national remote
search, and hopeless for a local one. "Chicago-area FP&A" means Naperville,
Deerfield, Oak Brook, Schaumburg — and Hammond, Indiana, and Kenosha,
Wisconsin. None of those carry the word "Chicago", and state=IL admits
Springfield and Peoria (200+ miles away). Metro is the unit a local job
search actually thinks in.

Data-driven and deliberately conservative: a suburb list per metro, plus the
metro's own city names. An unrecognized city yields "" — never a guess — so
a profile filtering on metro loses candidates rather than admitting noise
(and `filter_geo_unknown: keep` is the escape hatch for a user who would
rather see the unknowns).

Suburb lists cover the employment centers a job posting realistically names,
not every incorporated place in the MSA. Adding a metro is a data edit.
"""
from __future__ import annotations

# metro name -> (allowed state codes, city names in that metro)
METROS: dict[str, tuple[set[str], set[str]]] = {
    "Chicago": ({"IL", "IN", "WI"}, {
        # city + near north/west/south
        "chicago", "evanston", "skokie", "oak park", "berwyn", "cicero",
        "niles", "morton grove", "park ridge", "des plaines", "rosemont",
        "norridge", "harwood heights", "elmwood park", "river forest",
        "forest park", "maywood", "melrose park", "franklin park",
        "river grove", "schiller park", "bensenville", "wood dale",
        # north shore / lake county
        "wilmette", "winnetka", "glencoe", "highland park", "highwood",
        "lake forest", "lake bluff", "northbrook", "glenview", "deerfield",
        "riverwoods", "bannockburn", "lincolnshire", "vernon hills",
        "libertyville", "mundelein", "buffalo grove", "wheeling",
        "prospect heights", "arlington heights", "mount prospect",
        "palatine", "rolling meadows", "inverness", "barrington",
        "lake zurich", "gurnee", "waukegan", "north chicago", "grayslake",
        "round lake", "antioch", "zion",
        # northwest / dupage
        "schaumburg", "hoffman estates", "elk grove village", "itasca",
        "addison", "elmhurst", "villa park", "lombard", "glen ellyn",
        "wheaton", "carol stream", "bloomingdale", "roselle", "bartlett",
        "streamwood", "hanover park", "elgin", "south elgin", "st charles",
        "geneva", "batavia", "aurora", "naperville", "warrenville",
        "west chicago", "winfield", "lisle", "downers grove", "woodridge",
        "darien", "westmont", "clarendon hills", "hinsdale", "oak brook",
        "oakbrook terrace", "burr ridge", "willowbrook", "westchester",
        "la grange", "brookfield", "riverside", "lyons", "summit",
        # south / southwest
        "bolingbrook", "romeoville", "lemont", "lockport", "joliet",
        "plainfield", "shorewood", "new lenox", "mokena", "frankfort",
        "tinley park", "orland park", "oak lawn", "evergreen park",
        "palos hills", "palos heights", "bridgeview", "burbank",
        "chicago ridge", "alsip", "blue island", "harvey", "markham",
        "matteson", "olympia fields", "flossmoor", "homewood",
        "country club hills", "oak forest", "midlothian", "crestwood",
        "calumet city", "lansing", "south holland", "dolton", "riverdale",
        "chicago heights", "park forest", "university park", "crete",
        # mchenry / kane fringe
        "crystal lake", "algonquin", "cary", "mchenry", "woodstock",
        "huntley", "lake in the hills", "mchenry county",
        # northwest indiana
        "hammond", "gary", "east chicago", "whiting", "munster",
        "highland", "griffith", "schererville", "dyer", "st john",
        "crown point", "merrillville", "hobart", "portage", "valparaiso",
        "chesterton", "michigan city", "la porte",
        # southeast wisconsin (commutable border)
        "kenosha", "pleasant prairie", "somers", "racine",
    }),
    "New York": ({"NY", "NJ", "CT"}, {
        "new york", "new york city", "nyc", "manhattan", "brooklyn",
        "queens", "bronx", "staten island", "long island city", "astoria",
        "white plains", "yonkers", "new rochelle", "scarsdale", "purchase",
        "harrison", "tarrytown", "rye", "port chester", "mount vernon",
        "hicksville", "melville", "garden city", "mineola", "great neck",
        "jericho", "westbury", "uniondale", "islandia",
        "jersey city", "hoboken", "newark", "weehawken", "secaucus",
        "fort lee", "englewood cliffs", "hackensack", "paramus",
        "parsippany", "morristown", "florham park", "short hills",
        "murray hill", "berkeley heights", "warren", "bridgewater",
        "iselin", "woodbridge", "edison", "princeton", "basking ridge",
        "stamford", "greenwich", "norwalk", "westport", "darien",
        "shelton", "danbury",
    }),
    "San Francisco Bay Area": ({"CA"}, {
        "san francisco", "sf", "south san francisco", "brisbane",
        "daly city", "san bruno", "millbrae", "burlingame", "san mateo",
        "foster city", "belmont", "san carlos", "redwood city",
        "menlo park", "palo alto", "east palo alto", "mountain view",
        "los altos", "sunnyvale", "santa clara", "san jose", "cupertino",
        "campbell", "los gatos", "milpitas", "fremont", "newark",
        "union city", "hayward", "san leandro", "oakland", "emeryville",
        "berkeley", "alameda", "richmond", "san rafael", "sausalito",
        "novato", "petaluma", "walnut creek", "pleasant hill", "concord",
        "danville", "san ramon", "dublin", "pleasanton", "livermore",
        "bay area", "silicon valley",
    }),
    "Boston": ({"MA", "NH"}, {
        "boston", "cambridge", "somerville", "brookline", "newton",
        "watertown", "waltham", "lexington", "burlington", "woburn",
        "bedford", "billerica", "andover", "north andover", "lawrence",
        "lowell", "chelmsford", "westford", "acton", "concord", "maynard",
        "marlborough", "framingham", "natick", "needham", "wellesley",
        "dedham", "canton", "norwood", "westwood", "braintree", "quincy",
        "weymouth", "beverly", "danvers", "peabody", "salem", "lynn",
        "medford", "malden", "everett", "chelsea", "revere", "nashua",
        "seaport", "back bay",
    }),
    "Seattle": ({"WA"}, {
        "seattle", "bellevue", "redmond", "kirkland", "renton", "bothell",
        "issaquah", "sammamish", "mercer island", "kent", "auburn",
        "federal way", "tukwila", "seatac", "lynnwood", "everett",
        "edmonds", "shoreline", "woodinville", "tacoma", "puyallup",
    }),
    "Austin": ({"TX"}, {
        "austin", "round rock", "cedar park", "georgetown", "pflugerville",
        "leander", "kyle", "buda", "san marcos", "bee cave", "lakeway",
        "west lake hills", "manor",
    }),
    "Los Angeles": ({"CA"}, {
        "los angeles", "la", "santa monica", "culver city", "el segundo",
        "manhattan beach", "playa vista", "venice", "marina del rey",
        "beverly hills", "west hollywood", "hollywood", "burbank",
        "glendale", "pasadena", "long beach", "torrance", "carson",
        "inglewood", "irvine", "costa mesa", "newport beach", "anaheim",
        "santa ana", "orange", "fullerton", "cerritos", "woodland hills",
        "sherman oaks", "van nuys", "northridge", "calabasas",
        "thousand oaks", "westlake village", "santa clarita",
    }),
    "Denver": ({"CO"}, {
        "denver", "boulder", "aurora", "lakewood", "littleton",
        "englewood", "greenwood village", "centennial", "broomfield",
        "westminster", "arvada", "thornton", "northglenn", "louisville",
        "lafayette", "superior", "golden", "highlands ranch", "parker",
        "castle rock", "fort collins", "longmont", "erie",
    }),
    "Atlanta": ({"GA"}, {
        "atlanta", "alpharetta", "roswell", "sandy springs", "dunwoody",
        "marietta", "smyrna", "kennesaw", "duluth", "johns creek",
        "norcross", "peachtree corners", "lawrenceville", "decatur",
        "buckhead", "college park", "east point", "douglasville",
        "stockbridge", "mcdonough", "woodstock", "canton",
    }),
    "Washington DC": ({"DC", "MD", "VA"}, {
        "washington", "washington dc", "arlington", "alexandria",
        "crystal city", "rosslyn", "ballston", "mclean", "tysons",
        "tysons corner", "vienna", "reston", "herndon", "sterling",
        "ashburn", "chantilly", "fairfax", "falls church", "annandale",
        "springfield", "woodbridge", "manassas", "bethesda",
        "chevy chase", "silver spring", "rockville", "gaithersburg",
        "germantown", "columbia", "laurel", "college park", "greenbelt",
        "hyattsville", "bowie", "annapolis", "baltimore",
    }),
    "Dallas": ({"TX"}, {
        "dallas", "plano", "frisco", "richardson", "irving", "las colinas",
        "addison", "carrollton", "garland", "mesquite", "arlington",
        "fort worth", "grapevine", "southlake", "coppell", "lewisville",
        "flower mound", "mckinney", "allen", "denton", "rockwall",
    }),
    "Miami": ({"FL"}, {
        "miami", "miami beach", "coral gables", "doral", "hialeah",
        "aventura", "sunny isles beach", "brickell", "fort lauderdale",
        "sunrise", "plantation", "pembroke pines", "hollywood",
        "boca raton", "delray beach", "west palm beach", "jupiter",
        "coral springs", "weston", "miramar",
    }),
    "Phoenix": ({"AZ"}, {
        "phoenix", "scottsdale", "tempe", "mesa", "chandler", "gilbert",
        "glendale", "peoria", "surprise", "avondale", "goodyear",
    }),
    "Philadelphia": ({"PA", "NJ", "DE"}, {
        "philadelphia", "philly", "king of prussia", "conshohocken",
        "wayne", "radnor", "bala cynwyd", "blue bell", "fort washington",
        "horsham", "malvern", "chesterbrook", "west chester", "media",
        "bensalem", "newtown", "cherry hill", "camden", "moorestown",
        "mount laurel", "marlton", "wilmington", "newark",
    }),
    "Minneapolis": ({"MN", "WI"}, {
        "minneapolis", "st paul", "saint paul", "bloomington", "edina",
        "eden prairie", "minnetonka", "plymouth", "maple grove",
        "brooklyn park", "richfield", "roseville", "eagan", "burnsville",
        "woodbury", "st louis park", "saint louis park", "golden valley",
        "wayzata", "chanhassen", "chaska", "shakopee", "hudson",
    }),
}

# Only a metro's ANCHOR city may resolve without a state. Every suburb name
# is nationally ambiguous in practice — Duluth is a metro-Atlanta suburb AND a
# city in Minnesota; Louisville is a Denver suburb AND a city in Kentucky;
# Salem, Lexington, Plymouth, Franklin all repeat across states. Placing those
# from the name alone is exactly the confident guess this module promises not
# to make, so a suburb without a state resolves to "".
_ANCHORS = {
    "chicago": "Chicago",
    "chicagoland": "Chicago",
    "new york": "New York",
    "new york city": "New York",
    "nyc": "New York",
    "manhattan": "New York",
    "brooklyn": "New York",
    "san francisco": "San Francisco Bay Area",
    "bay area": "San Francisco Bay Area",
    "silicon valley": "San Francisco Bay Area",
    "boston": "Boston",
    "seattle": "Seattle",
    "austin": "Austin",
    "los angeles": "Los Angeles",
    "denver": "Denver",
    "atlanta": "Atlanta",
    "washington dc": "Washington DC",
    "dallas": "Dallas",
    "miami": "Miami",
    "phoenix": "Phoenix",
    "philadelphia": "Philadelphia",
    "philly": "Philadelphia",
    "minneapolis": "Minneapolis",
}

_CITY_INDEX: dict[str, list[tuple[str, set[str]]]] = {}
for _metro, (_states, _cities) in METROS.items():
    for _c in _cities:
        _CITY_INDEX.setdefault(_c, []).append((_metro, _states))


def metro_for(city: str, state: str = "") -> str:
    """(city, state) -> metro name, or "" when it can't be placed confidently.

    state is the 2-letter code (as geo.enrich produces). An ambiguous or
    multi-metro city name resolves only when the state agrees; a bare city
    with no state resolves only when it belongs to exactly one metro and
    isn't on the ambiguous list.
    """
    c = (city or "").strip().casefold()
    if not c:
        return ""
    st = (state or "").strip().upper()
    if not st:
        # No state: only an anchor city name is safe. Everything else could be
        # the same-named town in another state.
        return _ANCHORS.get(c, "")
    hits = _CITY_INDEX.get(c)
    if not hits:
        return ""
    matches = [m for m, states in hits if st in states]
    return matches[0] if len(matches) == 1 else ""


def is_anchor(name: str) -> bool:
    """True for a metro's primary city name — the only names safe to place
    without a state."""
    return (name or "").strip().casefold() in _ANCHORS


def names() -> list[str]:
    """Metro names available for a Search Profile's filter_metros knob."""
    return sorted(METROS)
