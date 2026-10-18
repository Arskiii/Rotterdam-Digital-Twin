"""Regression checks for the public feed adapters and geographic scope."""

import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime, timedelta, timezone

from scripts.update_public_data import (
    point_in_geometry,
    read_buildings,
    read_energy,
    read_traffic_measurements,
    read_traffic_sites,
    read_water,
    timestamp,
)
from scripts.update_history import merge_history, write_history
from scripts.check_public_data import check


class PublicDataTests(unittest.TestCase):
    def test_ndw_measurement_matches_only_local_detector_and_total_vehicle_index(self):
        sites_xml = """<root xmlns:r="http://datex2.eu/schema/3/roadTrafficData"
            xmlns:c="http://datex2.eu/schema/3/common"
            xmlns:l="http://datex2.eu/schema/3/locationReferencing">
          <r:measurementSite id="local"><r:measurementSiteName><c:value>Schiedamsedijk</c:value></r:measurementSiteName>
            <l:latitude>51.91461</l:latitude><l:longitude>4.481979</l:longitude>
            <r:measurementSpecificCharacteristics index="6"><r:measurementSpecificCharacteristics>
              <r:specificVehicleCharacteristics><c:vehicleType>anyVehicle</c:vehicleType></r:specificVehicleCharacteristics>
              <r:specificMeasurementValueType>trafficFlow</r:specificMeasurementValueType>
            </r:measurementSpecificCharacteristics></r:measurementSpecificCharacteristics>
            <r:measurementSpecificCharacteristics index="12"><r:measurementSpecificCharacteristics>
              <r:specificVehicleCharacteristics><c:vehicleType>anyVehicle</c:vehicleType></r:specificVehicleCharacteristics>
              <r:specificMeasurementValueType>trafficSpeed</r:specificMeasurementValueType>
            </r:measurementSpecificCharacteristics></r:measurementSpecificCharacteristics>
          </r:measurementSite>
          <r:measurementSite id="outside"><l:latitude>52.1</l:latitude><l:longitude>4.9</l:longitude></r:measurementSite>
        </root>"""
        sites, _ = read_traffic_sites(gzip.compress(sites_xml.encode()))
        self.assertEqual(list(sites), ["local"])
        readings_xml = """<root xmlns:r="http://datex2.eu/schema/3/roadTrafficData"
            xmlns:c="http://datex2.eu/schema/3/common">
          <r:siteMeasurements><r:measurementSiteReference id="local"/>
            <r:measurementTimeDefault><r:timeValue>2026-09-24T20:53:00Z</r:timeValue></r:measurementTimeDefault>
            <r:physicalQuantity index="6"><c:vehicleFlowRate>120</c:vehicleFlowRate></r:physicalQuantity>
            <r:physicalQuantity index="12"><r:averageVehicleSpeed numberOfInputValuesUsed="5"><c:speed>35</c:speed></r:averageVehicleSpeed></r:physicalQuantity>
          </r:siteMeasurements>
        </root>"""
        readings, _ = read_traffic_measurements(gzip.compress(readings_xml.encode()), sites)
        self.assertEqual(readings[0]["vehiclesPerHour"], 120)
        self.assertEqual(readings[0]["speedKmh"], 35)

    def test_future_water_readings_are_rejected(self):
        now = datetime(2026, 9, 24, 20, 0, tzinfo=timezone.utc)
        feature = {
            "geometry": {"coordinates": [4.48, 51.92]},
            "properties": {
                "CODE": "test", "NAAM": "Test station",
                "PARAMETER_WAT_OMSCHRIJVING": "Waterhoogte in Oppervlaktewater t.o.v. Normaal Amsterdams Peil",
                "TIJDSTIP_LAATSTE_METING": (now + timedelta(hours=2)).isoformat(),
                "WAARDE_LAATSTE_METING": 12,
            },
        }
        self.assertEqual(read_water({"features": [feature]}, now), [])

    def test_timezone_less_reading_is_rejected_without_failing_the_feed(self):
        self.assertIsNone(timestamp("2026-09-24T20:00:00"))
        self.assertEqual(timestamp("2026-09-24T22:00:00+02:00"),
                         datetime(2026, 9, 24, 20, 0, tzinfo=timezone.utc))

    def test_energy_uses_rotterdam_total_only(self):
        rows = {"value": [
            {"WijkenEnBuurten": "BU05990101", "Woningkenmerken": "T001100", "Measure": "M000219", "Value": 999},
            {"WijkenEnBuurten": "GM0599", "Woningkenmerken": "T001100", "Measure": "M000219", "Value": 580},
        ]}
        self.assertEqual(read_energy(rows)["gasM3"], 580)

    def test_3dbag_height_and_bag_year_are_joined_by_pand_id(self):
        ring = [[4.481, 51.915], [4.482, 51.915], [4.482, 51.916], [4.481, 51.915]]
        three_dbag = {"features": [{"geometry": {"type": "Polygon", "coordinates": [ring]},
                                     "properties": {"identificatie": "NL.IMBAG.Pand.0599100000123456",
                                                    "b3_h_70p": 18.2, "b3_h_maaiveld": -0.8}}]}
        bag = {"features": [{"properties": {"identificatie": "0599100000123456", "bouwjaar": 1935,
                                                "status": "Pand in gebruik"}}]}
        result = read_buildings(three_dbag, bag)
        self.assertEqual(result[0]["heightM"], 19.0)
        self.assertEqual(result[0]["constructionYear"], 1935)
        self.assertEqual(result[0]["rings"], [ring])

    def test_resilience_polygon_respects_holes(self):
        geometry = {"type": "Polygon", "coordinates": [
            [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
            [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
        ]}
        self.assertTrue(point_in_geometry(0.5, 0.5, geometry))
        self.assertFalse(point_in_geometry(2, 2, geometry))

    def test_history_deduplicates_and_rejects_bad_coordinates(self):
        now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        valid = {"id": "detector-1", "name": "Example", "lat": 51.915, "lon": 4.482,
                 "observedAt": "2026-09-25T11:55:00Z", "speedKmh": 32.0,
                 "vehiclesPerHour": 120}
        invalid = {**valid, "id": "bad", "lat": 0}
        result = merge_history([valid], [valid, invalid], now)
        self.assertEqual(result, [valid])

    def test_history_deduplicates_equivalent_offsets_and_sorts_by_instant(self):
        now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        valid = {"id": "detector-1", "name": "Example", "lat": 51.915, "lon": 4.482,
                 "observedAt": "2026-09-25T11:55:00Z", "speedKmh": 32.0,
                 "vehiclesPerHour": 120}
        equivalent = {**valid, "observedAt": "2026-09-25T13:55:00+02:00"}
        older = {**valid, "observedAt": "2026-09-25T13:50:00+02:00"}
        result = merge_history([valid], [equivalent, older], now)
        self.assertEqual(len(result), 2)
        self.assertEqual([row["observedAt"] for row in result],
                         ["2026-09-25T11:50:00Z", "2026-09-25T11:55:00Z"])

    def test_history_orders_fractional_seconds_chronologically(self):
        now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        reading = {"id": "detector-1", "name": "Example", "lat": 51.915, "lon": 4.482,
                   "observedAt": "2026-09-25T11:55:00Z", "speedKmh": 32.0,
                   "vehiclesPerHour": 120}
        later = {**reading, "observedAt": "2026-09-25T11:55:00.500Z"}
        result = merge_history([], [later, reading], now)
        self.assertEqual([row["observedAt"] for row in result],
                         ["2026-09-25T11:55:00Z", "2026-09-25T11:55:00.500000Z"])

    def test_zero_speed_is_preserved_without_a_flow_measurement(self):
        now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        row = {"id": "stopped", "lat": 51.915, "lon": 4.482, "observedAt": "2026-09-25T11:55:00Z",
               "speedKmh": 0, "vehiclesPerHour": None}
        merged = merge_history([], [row], now)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["speedKmh"], 0)

    def test_history_restores_observations_expires_old_rows_and_reports_coverage(self):
        now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        row = {"id": "detector", "lat": 51.915, "lon": 4.482, "observedAt": "2026-09-25T11:55:00Z",
               "speedKmh": 0, "vehiclesPerHour": None}
        with tempfile.TemporaryDirectory() as directory:
            snapshot, output = Path(directory) / "snapshot.json", Path(directory) / "history.json"
            snapshot.write_text(json.dumps({"traffic": {"readings": [row]}}))
            old = {**row, "observedAt": "2026-09-01T11:55:00Z"}
            previous = {**row, "observedAt": "2026-09-25T11:50:00Z"}
            output.write_text(json.dumps({"schemaVersion": 1, "readings": [old, previous]}))
            write_history(snapshot, output, now)
            data = json.loads(output.read_text())
            self.assertEqual(data["coverage"]["records"], 2)
            self.assertEqual(data["coverage"]["firstObservedAt"], previous["observedAt"])
            self.assertEqual(data["coverage"]["lastObservedAt"], row["observedAt"])
            self.assertEqual(len(data["readings"]), 2)
            self.assertEqual(len(list(Path(directory).iterdir())), 2)

    def test_history_preserves_previous_file_when_read_or_atomic_replace_fails(self):
        now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            snapshot, output = Path(directory) / "snapshot.json", Path(directory) / "history.json"
            snapshot.write_text('{"traffic":{"readings":[]}}')
            output.write_text("broken history")
            with self.assertRaises(ValueError):
                write_history(snapshot, output, now)
            self.assertEqual(output.read_text(), "broken history")
            original = '{"schemaVersion":1,"readings":[]}'
            output.write_text(original)
            with patch.object(Path, "replace", side_effect=OSError("write failed")):
                with self.assertRaises(OSError):
                    write_history(snapshot, output, now)
            self.assertEqual(output.read_text(), original)
            self.assertEqual(len(list(Path(directory).iterdir())), 2)

    def test_deploy_health_checks_measurement_age_not_only_download_time(self):
        now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        recent = "2026-09-25T11:59:00Z"
        sections = {name: {"retrievedAt": recent} for name in
                    ("traffic", "disruptions", "trees", "buildings", "resilience")}
        sections["buildings"]["buildings"] = [{}]
        sections["traffic"]["readings"] = [{"observedAt": "2026-09-25T01:00:00Z"}]
        errors, _ = check({"schemaVersion": 1, **sections}, {"schemaVersion": 1, "readings": []}, now)
        self.assertIn("NDW detector observations are missing or over two hours old", errors)

    def test_deploy_health_rejects_future_observations(self):
        now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        recent = "2026-09-25T11:59:00Z"
        sections = {name: {"retrievedAt": recent} for name in
                    ("traffic", "disruptions", "trees", "buildings", "resilience")}
        sections["buildings"]["buildings"] = [{}]
        sections["traffic"]["readings"] = [{"observedAt": "2027-09-25T11:59:00Z"}]
        errors, _ = check({"schemaVersion": 1, **sections}, {"schemaVersion": 1, "readings": []}, now)
        self.assertIn("NDW detector observations are missing or over two hours old", errors)

    def test_deploy_health_reports_invalid_document_shape(self):
        now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        errors, _ = check([], {"schemaVersion": 1, "readings": []}, now)
        self.assertEqual(errors, ["Snapshot and history must be JSON objects"])


if __name__ == "__main__":
    unittest.main()
