from django.test import TestCase, Client, override_settings
from django.urls import reverse
from django.contrib.gis.geos import Point

from maps.models import AmenityType, Amenity
from maps.views import normalize_longitude, get_cluster_grid_size


@override_settings(STORAGES={
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"}
})
class ViewsCoverageTest(TestCase):
    def setUp(self):
        self.client = Client()

        # Setup Amenity Types using get_or_create to avoid "already exists" errors
        self.type_restroom, _ = AmenityType.objects.get_or_create(
            name="Test Restroom", defaults={"color": "#000000"}
        )
        self.type_sub_restroom, _ = AmenityType.objects.get_or_create(
            name="Test Sub Restroom", defaults={"color": "#111111", "parent": self.type_restroom}
        )
        self.type_bike, _ = AmenityType.objects.get_or_create(
            name="Bike Rack", defaults={"color": "#ffffff"}  # Needs to match cluster logic string
        )

        # Setup Amenities using get_or_create
        self.amenity_active, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_restroom,
            external_id="test_active_restroom",
            defaults={
                "name": "Active Test Restroom",
                "location": Point(-73.99, 40.73),
                "active": True,
                "accessibility": "Fully Accessible",
            }
        )
        self.amenity_inactive, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_bike,
            external_id="test_inactive_bike",
            defaults={
                "name": "Inactive Test Bike Rack",
                "location": Point(-73.98, 40.74),
                "active": False,
                "accessibility": "Not Accessible",
            }
        )
        self.amenity_bike_cluster1, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_bike,
            external_id="test_cluster1_bike",
            defaults={
                "name": "Bike Rack Cluster 1",
                "location": Point(-73.9801, 40.7401),
                "active": True,
                "accessibility": "Partially Accessible",
            }
        )
        self.amenity_bike_cluster2, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_bike,
            external_id="test_cluster2_bike",
            defaults={
                "name": "Bike Rack Cluster 2",
                "location": Point(-73.9802, 40.7402),
                "active": True,
                "accessibility": "Partially Accessible",
            }
        )

    def test_normalize_longitude(self):
        self.assertEqual(normalize_longitude(100), 100)
        self.assertEqual(normalize_longitude(190), -170)
        self.assertEqual(normalize_longitude(-190), 170)

    def test_get_cluster_grid_size(self):
        self.assertEqual(get_cluster_grid_size(4), 0.1)
        self.assertEqual(get_cluster_grid_size(17), 0.001)

    def test_map_view(self):
        response = self.client.get(reverse("maps:map"))
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "maps/map.html")
        self.assertIn("amenity_types", response.context)

    def test_amenity_types_api(self):
        response = self.client.get(reverse("maps:amenity_types_api"))
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("types", data)

    # --- Amenities API Tests (Query/Read Only) ---
    def test_amenities_api_basic(self):
        response = self.client.get(reverse("maps:amenities_api"))
        self.assertEqual(response.status_code, 200)
        data = response.json()
        ids = [a.get("id") for a in data["amenities"] if "id" in a]
        self.assertIn(self.amenity_active.id, ids)
        self.assertNotIn(self.amenity_inactive.id, ids)

    def test_amenities_api_include_inactive(self):
        response = self.client.get(reverse("maps:amenities_api"), {"include_inactive": "true"})
        data = response.json()
        ids = [a.get("id") for a in data["amenities"] if "id" in a]
        self.assertIn(self.amenity_inactive.id, ids)

    def test_amenities_api_only_accessible(self):
        response = self.client.get(reverse("maps:amenities_api"), {"only_accessible": "true", "include_inactive": "true"})
        data = response.json()
        ids = [a.get("id") for a in data["amenities"] if "id" in a]
        self.assertIn(self.amenity_active.id, ids)  # Fully Accessible
        self.assertNotIn(self.amenity_inactive.id, ids)  # Not Accessible

    def test_amenities_api_filter_by_type_id(self):
        response = self.client.get(reverse("maps:amenities_api"), {"type_id": self.type_restroom.id})
        data = response.json()
        self.assertTrue(len(data["amenities"]) >= 1)
        ids = [a["id"] for a in data["amenities"]]
        self.assertIn(self.amenity_active.id, ids)

    def test_amenities_api_filter_by_type_name(self):
        response = self.client.get(reverse("maps:amenities_api"), {"type": "Test Restroom"})
        data = response.json()
        self.assertTrue(len(data["amenities"]) >= 1)
        ids = [a["id"] for a in data["amenities"]]
        self.assertIn(self.amenity_active.id, ids)

    def test_amenities_api_bbox_filter(self):
        response = self.client.get(reverse("maps:amenities_api"), {
            "north": 41.0, "south": 40.0, "east": -73.0, "west": -74.0
        })
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(len(data["amenities"]) > 0)

    def test_amenities_api_invalid_bbox(self):
        response = self.client.get(reverse("maps:amenities_api"), {
            "north": "invalid", "south": "invalid", "east": "invalid", "west": "invalid"
        })
        self.assertEqual(response.status_code, 200)

    def test_amenities_api_clustering(self):
        response = self.client.get(reverse("maps:amenities_api"), {
            "type_id": self.type_bike.id,
            "zoom": 10
        })
        data = response.json()
        clusters = [a for a in data["amenities"] if a.get("is_cluster")]
        self.assertTrue(len(clusters) > 0)

    def test_amenities_api_clustering_single_point(self):
        distant, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_bike,
            external_id="test_distant_bike",
            defaults={"name": "Distant Rack", "location": Point(10.0, 10.0), "active": True}
        )
        response = self.client.get(reverse("maps:amenities_api"), {
            "type_id": self.type_bike.id,
            "zoom": 10,
            "north": 11.0, "south": 9.0, "east": 11.0, "west": 9.0  # Isolate it
        })
        data = response.json()
        self.assertFalse(any(a.get("is_cluster") for a in data["amenities"]))
        ids = [a["id"] for a in data["amenities"]]
        self.assertIn(distant.id, ids)