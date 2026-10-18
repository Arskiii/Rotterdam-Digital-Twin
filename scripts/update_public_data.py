"""Build a small, source-labelled Rotterdam snapshot for the static Pages site.

All inputs are public read-only services. Network failures retain the previous
section so a deployment still builds; the browser marks old observations stale.
"""

import argparse
import gzip
import io
import json
import math
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public/data/rotterdam-snapshot.json"
BOUNDS = (51.914256, 4.480512, 51.919576, 4.492979)
ROA = "http://datex2.eu/schema/3/roadTrafficData"
COM = "http://datex2.eu/schema/3/common"
LOC = "http://datex2.eu/schema/3/locationReferencing"
SIT = "http://datex2.eu/schema/3/situation"
NS = {"r": ROA, "c": COM, "l": LOC, "s": SIT}
NDW_BASE = "https://opendata.ndw.nu/"
TREE_URL = "https://diensten.rotterdam.nl/arcgis/rest/services/SB_Infra/Bomen/MapServer/0/query"
WATER_URL = "https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/ows"
AIR_URL = "https://api.luchtmeetnet.nl/open_api/stations/NL10418"
CBS_URL = "https://datasets.cbs.nl/odata/v1/CBS/86333NED/Observations"
THREEDBAG_URL = "https://data.3dbag.nl/api/BAG3D/wfs"
BAG_URL = "https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items"
RESILIENCE_URL = "https://diensten.rotterdam.nl/arcgis/rest/services/SO_IBURO/DGO_data/MapServer"


def utc_now():
    return datetime.now(timezone.utc)


def iso(value):
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        # A missing timezone cannot be compared with UTC observations safely.
        # Reject only this reading rather than failing the entire feed refresh.
        return parsed.astimezone(timezone.utc) if parsed.tzinfo is not None else None
    except (AttributeError, ValueError):
        return None


def within(lat, lon, padding=0):
    return (BOUNDS[0] - padding <= lat <= BOUNDS[2] + padding and
            BOUNDS[1] - padding <= lon <= BOUNDS[3] + padding)


def get_bytes(url, max_bytes=60_000_000):
    request = Request(url, headers={"User-Agent": "Rotterdam-Digital-Twin/0.3 public-data-snapshot"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=25) as response:
                data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise ValueError(f"Response too large: {url}")
            return data
        except (HTTPError, URLError, TimeoutError) as error:
            if (isinstance(error, HTTPError) and error.code < 500) or attempt == 2:
                raise
            time.sleep(attempt + 1)


def source_bytes(url, local_path=None):
    return Path(local_path).read_bytes() if local_path else get_bytes(url)


def xml_stream(compressed):
    return gzip.GzipFile(fileobj=io.BytesIO(compressed))


def read_traffic_sites(compressed):
    sites = {}
    publication = None
    for _, element in ET.iterparse(xml_stream(compressed), events=("end",)):
        local = element.tag.rsplit("}", 1)[-1]
        if local == "publicationTime" and publication is None:
            publication = element.text
        if local != "measurementSite":
            continue
        lat_el = element.find(".//l:latitude", NS)
        lon_el = element.find(".//l:longitude", NS)
        if lat_el is not None and lon_el is not None:
            lat, lon = float(lat_el.text), float(lon_el.text)
            if within(lat, lon):
                name_el = element.find(".//r:measurementSiteName//c:value", NS)
                indices = {"flow": [], "speed": []}
                for characteristic in element.findall("r:measurementSpecificCharacteristics", NS):
                    details = characteristic.find("r:measurementSpecificCharacteristics", NS)
                    if details is None:
                        continue
                    vehicles = details.find("r:specificVehicleCharacteristics", NS)
                    if vehicles is not None and (vehicles.find("c:vehicleType", NS) is None or
                                                 vehicles.findtext("c:vehicleType", namespaces=NS) != "anyVehicle"):
                        continue
                    kind = details.findtext("r:specificMeasurementValueType", namespaces=NS)
                    if kind == "trafficFlow":
                        indices["flow"].append(characteristic.attrib["index"])
                    elif kind == "trafficSpeed":
                        indices["speed"].append(characteristic.attrib["index"])
                sites[element.attrib["id"]] = {
                    "id": element.attrib["id"], "name": name_el.text if name_el is not None else "Traffic detector",
                    "lat": lat, "lon": lon, "indices": indices,
                }
        element.clear()
    return sites, publication


def read_traffic_measurements(compressed, sites):
    readings = []
    publication = None
    for _, element in ET.iterparse(xml_stream(compressed), events=("end",)):
        local = element.tag.rsplit("}", 1)[-1]
        if local == "publicationTime" and publication is None:
            publication = element.text
        if local != "siteMeasurements":
            continue
        reference = element.find("r:measurementSiteReference", NS)
        site = sites.get(reference.attrib.get("id")) if reference is not None else None
        if site:
            observed_at = element.findtext("r:measurementTimeDefault/r:timeValue", namespaces=NS)
            by_index = {quantity.attrib.get("index"): quantity for quantity in element.findall("r:physicalQuantity", NS)}
            flows, speeds = [], []
            for index in site["indices"]["flow"]:
                quantity = by_index.get(index)
                value = quantity.findtext(".//c:vehicleFlowRate", namespaces=NS) if quantity is not None else None
                if value is not None and 0 <= float(value) <= 100_000:
                    flows.append(float(value))
            for index in site["indices"]["speed"]:
                quantity = by_index.get(index)
                speed = quantity.find(".//r:averageVehicleSpeed", NS) if quantity is not None else None
                value = speed.findtext("c:speed", namespaces=NS) if speed is not None else None
                if value is not None and speed.attrib.get("numberOfInputValuesUsed", "1") != "0" and 0 < float(value) <= 200:
                    speeds.append(float(value))
            if observed_at and (flows or speeds):
                readings.append({
                    "id": site["id"], "name": site["name"], "lat": site["lat"], "lon": site["lon"],
                    "observedAt": observed_at,
                    "vehiclesPerHour": round(sum(flows)) if flows else None,
                    "speedKmh": round(sum(speeds) / len(speeds), 1) if speeds else None,
                })
        element.clear()
    return readings, publication


def read_disruptions(compressed, now):
    events = []
    publication = None
    for _, element in ET.iterparse(xml_stream(compressed), events=("end",)):
        local = element.tag.rsplit("}", 1)[-1]
        if local == "publicationTime" and publication is None:
            publication = element.text
        if local != "situation":
            continue
        first_record = element.find("s:situationRecord", NS)
        first_values = [v.text.strip() for v in first_record.findall(".//c:value", NS) if v.text and v.text.strip()] if first_record is not None else []
        headline = next((v for v in first_values if v != "Gemeente Rotterdam" and len(v) > 4), "Road disruption")
        headline = re.sub(r"\s*,\s*,", ",", headline).strip(" ,")
        for record in element.findall("s:situationRecord", NS):
            start = timestamp(record.findtext(".//c:overallStartTime", namespaces=NS))
            end = timestamp(record.findtext(".//c:overallEndTime", namespaces=NS))
            if start and (not end or end >= now) and start <= now + timedelta(days=30):
                coordinates = []
                for path in record.findall(".//l:posList", NS):
                    values = path.text.split() if path.text else []
                    for i in range(0, len(values) - 1, 2):
                        coordinates.append((float(values[i]), float(values[i + 1])))
                for point in record.findall(".//l:pos", NS):
                    values = point.text.split() if point.text else []
                    if len(values) >= 2:
                        coordinates.append((float(values[0]), float(values[1])))
                match = next(((lat, lon) for lat, lon in coordinates if within(lat, lon)), None)
                if match:
                    values = [v.text.strip() for v in record.findall(".//c:value", NS) if v.text and v.text.strip()]
                    detail = next((v for v in values if v != "Gemeente Rotterdam" and len(v) > 4), "")
                    detail = re.sub(r"\s*,\s*,", ",", detail).strip(" ,")
                    events.append({
                        "id": element.attrib.get("id", ""), "lat": match[0], "lon": match[1],
                        "description": headline[:140], "detail": detail[:100] if detail != headline else "",
                        "severity": element.findtext("s:overallSeverity", default="unknown", namespaces=NS),
                        "startsAt": iso(start), "endsAt": iso(end) if end else None,
                    })
                    break
        element.clear()
    return events[:100], publication


def read_trees(document):
    trees = []
    for feature in document.get("features", []):
        geometry = feature.get("geometry") or {}
        point = geometry.get("coordinates") or []
        if geometry.get("type") != "Point" or len(point) < 2 or not within(point[1], point[0]):
            continue
        properties = feature.get("properties") or {}
        trees.append({
            "id": feature.get("id"), "lat": point[1], "lon": point[0],
            "species": str(properties.get("BOOMSORTIMENT") or "Tree")[:80],
            "height": str(properties.get("HOOGTE") or "")[:24],
        })
    return trees


def read_water(document, now):
    latest = {}
    for feature in document.get("features", []):
        point = (feature.get("geometry") or {}).get("coordinates") or []
        props = feature.get("properties") or {}
        if len(point) < 2 or not (51.85 <= point[1] <= 52.02 and 4.35 <= point[0] <= 4.65):
            continue
        if not str(props.get("PARAMETER_WAT_OMSCHRIJVING", "")).startswith("Waterhoogte in Oppervlaktewater t.o.v. Normaal Amsterdams Peil"):
            continue
        observed = timestamp(props.get("TIJDSTIP_LAATSTE_METING"))
        value = props.get("WAARDE_LAATSTE_METING")
        if not observed or not isinstance(value, (int, float)) or not -1000 <= value <= 1000:
            continue
        if not -600 <= (now - observed).total_seconds() <= 10_800:
            continue
        key = props.get("CODE") or props.get("NAAM")
        if key and (key not in latest or observed > timestamp(latest[key]["observedAt"])):
            latest[key] = {
                "id": key, "name": str(props.get("NAAM") or key)[:100],
                "lat": point[1], "lon": point[0], "cmNAP": value, "observedAt": iso(observed),
            }
    return sorted(latest.values(), key=lambda item: item["name"])


def read_air(station, measurements, now):
    data = station["data"]
    point = data["geometry"]["coordinates"]
    values = {}
    for formula, document in measurements.items():
        for row in document.get("data", []):
            observed = timestamp(row.get("timestamp_measured"))
            value = row.get("value")
            if observed and isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value <= 1000 and -600 <= (now - observed).total_seconds() <= 10_800:
                values[formula] = {"value": round(value, 1), "observedAt": iso(observed)}
                break
    return {"station": "NL10418", "name": data["location"], "lat": point[1], "lon": point[0], "values": values}


def read_energy(document):
    values = {row["Measure"]: row.get("Value") for row in document.get("value", [])
              if row.get("WijkenEnBuurten") == "GM0599" and row.get("Woningkenmerken") == "T001100"}
    if not values:
        raise ValueError("CBS Rotterdam total missing")
    return {"year": 2025, "region": "Rotterdam municipality", "gasM3": values.get("M000219"),
            "electricityKwh": values.get("M000221"), "districtHeatingPercent": values.get("M002874")}


def read_buildings(three_dbag, bag):
    bag_by_id = {str(f.get("properties", {}).get("identificatie")): f.get("properties", {})
                 for f in bag.get("features", [])}
    buildings = []
    for feature in three_dbag.get("features", []):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Polygon":
            continue
        rings = geometry.get("coordinates") or []
        if not rings or len(rings[0]) < 4 or len(rings[0]) > 500:
            continue
        props = feature.get("properties") or {}
        roof, ground = props.get("b3_h_70p"), props.get("b3_h_maaiveld")
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (roof, ground)):
            continue
        height = roof - ground
        if not 1 <= height <= 300:
            continue
        ident = str(props.get("identificatie") or "")
        bag_record = bag_by_id.get(ident.removeprefix("NL.IMBAG.Pand."), {})
        year = bag_record.get("bouwjaar")
        if not isinstance(year, int) or not 1800 <= year <= utc_now().year + 2:
            year = None
        buildings.append({
            "id": ident, "heightM": round(height, 1), "constructionYear": year,
            "status": str(bag_record.get("status") or "")[:60],
            "rings": [[[round(float(lon), 8), round(float(lat), 8)] for lon, lat in ring]
                      for ring in rings if 4 <= len(ring) <= 500],
        })
    return buildings


def point_in_ring(lon, lat, ring):
    inside = False
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        if (a[1] > lat) != (b[1] > lat):
            crossing = (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]
            if lon < crossing:
                inside = not inside
    return inside


def point_in_geometry(lon, lat, geometry):
    polygons = [geometry.get("coordinates", [])] if geometry.get("type") == "Polygon" else geometry.get("coordinates", [])
    for rings in polygons:
        if rings and point_in_ring(lon, lat, rings[0]) and not any(point_in_ring(lon, lat, hole) for hole in rings[1:]):
            return True
    return False


def read_resilience(cooling, flood, noise):
    columns, rows = 28, 20
    ordered = sorted(cooling.get("features", []), key=lambda f: f.get("properties", {}).get("Shape_Area") or 0)
    cells = []
    for row in range(rows):
        lat = BOUNDS[0] + (row + 0.5) * (BOUNDS[2] - BOUNDS[0]) / rows
        for column in range(columns):
            lon = BOUNDS[1] + (column + 0.5) * (BOUNDS[3] - BOUNDS[1]) / columns
            match = next((f for f in ordered if point_in_geometry(lon, lat, f.get("geometry") or {})), None)
            value = (match or {}).get("properties", {}).get("grid_code")
            cells.append(value if isinstance(value, (int, float)) and 0 <= value <= 2000 else None)

    def compact_polygons(document, field, minimum, maximum):
        output = []
        for feature in document.get("features", []):
            geometry = feature.get("geometry") or {}
            polygons = [geometry.get("coordinates", [])] if geometry.get("type") == "Polygon" else geometry.get("coordinates", [])
            value = (feature.get("properties") or {}).get(field)
            if not isinstance(value, (int, float)) or not minimum <= value <= maximum:
                continue
            for rings in polygons:
                if not rings or len(rings[0]) > 2000:
                    continue
                output.append({"value": round(value, 1), "rings": [
                    [[round(float(lon), 8), round(float(lat), 8)] for lon, lat in ring]
                    for ring in rings if 4 <= len(ring) <= 2000]})
        return output[:500]

    return {"coolAccess": {"columns": columns, "rows": rows, "distanceM": cells},
            "floodDepth25cm": compact_polygons(flood, "gridcode", 25, 1000),
            "noiseDb": compact_polygons(noise, "max_cumm_l", 0, 120)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--roadworks-file")
    parser.add_argument("--traffic-file")
    parser.add_argument("--sites-file")
    parser.add_argument("--trees-file")
    parser.add_argument("--water-file")
    parser.add_argument("--air-station-file")
    parser.add_argument("--air-no2-file")
    parser.add_argument("--cbs-file")
    parser.add_argument("--three-dbag-file")
    parser.add_argument("--bag-file")
    parser.add_argument("--cooling-file")
    parser.add_argument("--flood-file")
    parser.add_argument("--noise-file")
    args = parser.parse_args()
    now = utc_now()
    result = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {"schemaVersion": 1}
    health = result.setdefault("health", {})

    def update(name, producer):
        try:
            section = producer()
            if name in ("trees", "buildings") and not section.get(name):
                raise ValueError("unexpected empty geographic layer")
            result[name] = section
            health[name] = {"status": "ok", "lastAttemptAt": iso(now), "lastSuccessAt": iso(now)}
            print(f"Updated {name}")
        except Exception as error:
            previous = result.get(name) or {}
            health[name] = {"status": "stale" if previous else "unavailable",
                            "lastAttemptAt": iso(now), "lastSuccessAt": previous.get("retrievedAt"),
                            "errorType": type(error).__name__}
            print(f"Could not update {name}: {error}")

    def traffic():
        locations = source_bytes(NDW_BASE + "snelheden_en_intensiteiten_configuratie_meetlocaties.xml.gz", args.sites_file)
        values = source_bytes(NDW_BASE + "snelheden_en_intensiteiten_meetgegevens.xml.gz", args.traffic_file)
        sites, _ = read_traffic_sites(locations)
        readings, published = read_traffic_measurements(values, sites)
        return {"source": NDW_BASE, "retrievedAt": iso(now), "publishedAt": published, "readings": readings}

    def disruptions():
        events, published = read_disruptions(source_bytes(NDW_BASE + "planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz", args.roadworks_file), now)
        return {"source": NDW_BASE, "retrievedAt": iso(now), "publishedAt": published, "events": events}

    def trees():
        params = {"f": "geojson", "where": "1=1", "geometry": "4.480512,51.914256,4.492979,51.919576",
                  "geometryType": "esriGeometryEnvelope", "inSR": "4326", "outSR": "4326",
                  "spatialRel": "esriSpatialRelIntersects", "outFields": "ID,BOOMSORTIMENT,HOOGTE"}
        document = json.loads(source_bytes(TREE_URL + "?" + urlencode(params), args.trees_file))
        return {"source": TREE_URL, "retrievedAt": iso(now), "trees": read_trees(document)}

    def water():
        water_height_filter = ('<Filter><PropertyIsLike escape="!" singleChar="." wildCard="*">'
                               '<PropertyName>PARAMETER_WAT_OMSCHRIJVING</PropertyName>'
                               '<Literal>*Waterhoogte*</Literal></PropertyIsLike></Filter>')
        params = {"SERVICE": "WFS", "VERSION": "1.1.0", "REQUEST": "GetFeature",
                  "TYPENAME": "locatiesmetlaatstewaarneming", "outputFormat": "application/json",
                  "FILTER": water_height_filter}
        document = json.loads(source_bytes(WATER_URL + "?" + urlencode(params), args.water_file))
        return {"source": WATER_URL, "retrievedAt": iso(now), "readings": read_water(document, now)}

    def air():
        station = json.loads(source_bytes(AIR_URL, args.air_station_file))
        measurements = {}
        for formula in ("NO2", "PM25", "PM10"):
            params = {"formula": formula, "order": "timestamp_measured", "order_direction": "desc", "page": 1}
            local = args.air_no2_file if formula == "NO2" else None
            measurements[formula] = json.loads(source_bytes(AIR_URL + "/measurements?" + urlencode(params), local))
        return {"source": "https://www.luchtmeetnet.nl/meetpunten?component=NO2&station=NL10418",
                "retrievedAt": iso(now), "reading": read_air(station, measurements, now)}

    def energy():
        params = {"$filter": "WijkenEnBuurten eq 'GM0599' and Woningkenmerken eq 'T001100'", "$top": "20"}
        document = json.loads(source_bytes(CBS_URL + "?" + urlencode(params), args.cbs_file))
        return {"source": "https://www.cbs.nl/nl-nl/cijfers/detail/86333NED", "retrievedAt": iso(now),
                "reading": read_energy(document)}

    def buildings():
        params = {"request": "getfeature", "service": "wfs", "version": "2.0.0", "typenames": "BAG3D:lod12",
                  "bbox": "4.480512,51.914256,4.492979,51.919576,EPSG:4326", "srsName": "EPSG:4326",
                  "outputFormat": "application/json", "count": "1000"}
        three_dbag = json.loads(source_bytes(THREEDBAG_URL + "?" + urlencode(params), args.three_dbag_file))
        bag_params = {"bbox": "4.480512,51.914256,4.492979,51.919576", "limit": "1000", "f": "json"}
        bag = json.loads(source_bytes(BAG_URL + "?" + urlencode(bag_params), args.bag_file))
        return {"source": "https://3dbag.nl/download", "bagSource": "https://api.pdok.nl/kadaster/bag/ogc/v2",
                "retrievedAt": iso(now), "buildings": read_buildings(three_dbag, bag)}

    def resilience():
        params = {"f": "geojson", "where": "1=1", "geometry": "4.480512,51.914256,4.492979,51.919576",
                  "geometryType": "esriGeometryEnvelope", "inSR": "4326", "outSR": "4326",
                  "spatialRel": "esriSpatialRelIntersects", "outFields": "*"}
        def layer(number, local):
            return json.loads(source_bytes(f"{RESILIENCE_URL}/{number}/query?" + urlencode(params), local))
        result = read_resilience(layer(3, args.cooling_file), layer(13, args.flood_file), layer(20, args.noise_file))
        return {"source": RESILIENCE_URL, "retrievedAt": iso(now), **result}

    update("traffic", traffic)
    update("disruptions", disruptions)
    update("trees", trees)
    update("water", water)
    update("air", air)
    update("energy", energy)
    update("buildings", buildings)
    update("resilience", resilience)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
