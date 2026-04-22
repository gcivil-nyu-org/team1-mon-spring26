from pathlib import Path

from django.test import SimpleTestCase


class MapDeepLinkRegressionTests(SimpleTestCase):
    def test_focus_amenity_from_query_does_not_set_selected_marker_to_destination(self):
        map_js_path = Path(__file__).parent / "static" / "maps" / "js" / "map.js"
        map_js = map_js_path.read_text(encoding="utf-8")

        function_start = map_js.find("function focusAmenityFromQuery(amenityId) {")
        self.assertNotEqual(function_start, -1)

        function_end = map_js.find("/** Auth Wiring */", function_start)
        self.assertNotEqual(function_end, -1)

        function_body = map_js[function_start:function_end]

        self.assertNotIn(
            "selectedLocationMarker = L.marker([amenity.latitude, amenity.longitude]",
            function_body,
        )
        self.assertIn("showDetailPanel(amenity);", function_body)
