import json
from django.test import TestCase, Client, override_settings
from django.urls import reverse
from django.contrib.gis.geos import Point
from django.core.files.uploadedfile import SimpleUploadedFile
from unittest.mock import patch

from maps.models import AmenityType, Amenity, CustomUser, Review, AmenityPhoto
from maps.views import normalize_longitude, get_cluster_grid_size


@override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {
            "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"
        },
    }
)
class ViewsCoverageTest(TestCase):
    def setUp(self):
        self.client = Client()

        self.test_user, _ = CustomUser.objects.get_or_create(
            username="testauth",
            email="auth@example.com",
        )
        self.test_user.set_password("password123")
        self.test_user.save()

        # Setup Amenity Types using get_or_create to avoid "already exists" errors
        self.type_restroom, _ = AmenityType.objects.get_or_create(
            name="Test Restroom", defaults={"color": "#000000"}
        )
        self.type_sub_restroom, _ = AmenityType.objects.get_or_create(
            name="Test Sub Restroom",
            defaults={"color": "#111111", "parent": self.type_restroom},
        )
        self.type_bike, _ = AmenityType.objects.get_or_create(
            name="Bike Rack",
            defaults={"color": "#ffffff"},  # Needs to match cluster logic string
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
            },
        )
        self.amenity_inactive, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_bike,
            external_id="test_inactive_bike",
            defaults={
                "name": "Inactive Test Bike Rack",
                "location": Point(-73.98, 40.74),
                "active": False,
                "accessibility": "Not Accessible",
            },
        )
        self.amenity_bike_cluster1, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_bike,
            external_id="test_cluster1_bike",
            defaults={
                "name": "Bike Rack Cluster 1",
                "location": Point(-73.9801, 40.7401),
                "active": True,
                "accessibility": "Partially Accessible",
            },
        )
        self.amenity_bike_cluster2, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_bike,
            external_id="test_cluster2_bike",
            defaults={
                "name": "Bike Rack Cluster 2",
                "location": Point(-73.9802, 40.7402),
                "active": True,
                "accessibility": "Partially Accessible",
            },
        )

    def test_normalize_longitude(self):
        self.assertEqual(normalize_longitude(100), 100)
        self.assertEqual(normalize_longitude(190), -170)
        self.assertEqual(normalize_longitude(-190), 170)

    def test_get_cluster_grid_size(self):
        self.assertEqual(get_cluster_grid_size(4), 0.1)
        self.assertEqual(get_cluster_grid_size(6), 0.075)
        self.assertEqual(get_cluster_grid_size(8), 0.05)
        self.assertEqual(get_cluster_grid_size(10), 0.04)
        self.assertEqual(get_cluster_grid_size(12), 0.03)
        self.assertEqual(get_cluster_grid_size(13), 0.02)
        self.assertEqual(get_cluster_grid_size(14), 0.01)
        self.assertEqual(get_cluster_grid_size(15), 0.005)
        self.assertEqual(get_cluster_grid_size(16), 0.002)
        self.assertEqual(get_cluster_grid_size(17), 0.001)
        self.assertEqual(get_cluster_grid_size(20), 0.001)

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
        response = self.client.get(
            reverse("maps:amenities_api"), {"include_inactive": "true"}
        )
        data = response.json()
        ids = [a.get("id") for a in data["amenities"] if "id" in a]
        self.assertIn(self.amenity_inactive.id, ids)

    def test_amenities_api_only_accessible(self):
        response = self.client.get(
            reverse("maps:amenities_api"),
            {"only_accessible": "true", "include_inactive": "true"},
        )
        data = response.json()
        ids = [a.get("id") for a in data["amenities"] if "id" in a]
        self.assertIn(self.amenity_active.id, ids)  # Fully Accessible
        self.assertNotIn(self.amenity_inactive.id, ids)  # Not Accessible

    def test_amenities_api_filter_by_type_id(self):
        response = self.client.get(
            reverse("maps:amenities_api"), {"type_id": self.type_restroom.id}
        )
        data = response.json()
        self.assertTrue(len(data["amenities"]) >= 1)
        ids = [a["id"] for a in data["amenities"]]
        self.assertIn(self.amenity_active.id, ids)

    def test_amenities_api_filter_by_type_name(self):
        response = self.client.get(
            reverse("maps:amenities_api"), {"type": "Test Restroom"}
        )
        data = response.json()
        self.assertTrue(len(data["amenities"]) >= 1)
        ids = [a["id"] for a in data["amenities"]]
        self.assertIn(self.amenity_active.id, ids)

    def test_amenities_api_bbox_filter(self):
        response = self.client.get(
            reverse("maps:amenities_api"),
            {"north": 41.0, "south": 40.0, "east": -73.0, "west": -74.0},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(len(data["amenities"]) > 0)

    def test_amenities_api_invalid_bbox(self):
        response = self.client.get(
            reverse("maps:amenities_api"),
            {
                "north": "invalid",
                "south": "invalid",
                "east": "invalid",
                "west": "invalid",
            },
        )
        self.assertEqual(response.status_code, 200)

    @patch("maps.views.cluster_amenities")
    def test_amenities_api_clustering(self, mock_cluster):
        mock_cluster.return_value = [
            (
                [self.amenity_bike_cluster1.id, self.amenity_bike_cluster2.id],
                2,
                "POINT(-73.98015 40.74015)",
                None,
            )
        ]
        response = self.client.get(
            reverse("maps:amenities_api"), {"type_id": self.type_bike.id, "zoom": 10}
        )
        data = response.json()
        clusters = [a for a in data["amenities"] if a.get("is_cluster")]
        self.assertTrue(len(clusters) > 0)

    @patch("maps.views.cluster_amenities")
    def test_amenities_api_clustering_single_point(self, mock_cluster):
        distant, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_bike,
            external_id="test_distant_bike",
            defaults={
                "name": "Distant Rack",
                "location": Point(10.0, 10.0),
                "active": True,
            },
        )
        mock_cluster.return_value = [([distant.id], 1, "POINT(10.0 10.0)", None)]
        response = self.client.get(
            reverse("maps:amenities_api"),
            {
                "type_id": self.type_bike.id,
                "zoom": 10,
                "north": 11.0,
                "south": 9.0,
                "east": 11.0,
                "west": 9.0,  # Isolate it
            },
        )
        data = response.json()
        self.assertFalse(any(a.get("is_cluster") for a in data["amenities"]))
        ids = [a["id"] for a in data["amenities"]]
        self.assertIn(distant.id, ids)

    def test_amenities_api_zoomed_in_bike_racks(self):
        response = self.client.get(
            reverse("maps:amenities_api"), {"type_id": self.type_bike.id, "zoom": 19}
        )
        data = response.json()
        clusters = [a for a in data["amenities"] if a.get("is_cluster")]
        self.assertEqual(len(clusters), 0)

        AmenityType.objects.filter(name="Bike Rack").delete()
        response2 = self.client.get(reverse("maps:amenities_api"))
        self.assertEqual(response2.status_code, 200)

    def test_amenities_api_serialization_with_reviews_and_photos(self):
        Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=4,
            review_text="Nice",
        )
        photo = SimpleUploadedFile(
            "test.jpg", b"file_content", content_type="image/jpeg"
        )
        AmenityPhoto.objects.create(
            amenity=self.amenity_active, uploaded_by=self.test_user, photo=photo
        )

        response = self.client.get(reverse("maps:amenities_api"))
        data = response.json()
        active = next(
            (a for a in data["amenities"] if a["id"] == self.amenity_active.id), None
        )
        self.assertIsNotNone(active)
        self.assertTrue(len(active["reviews"]) > 0)
        self.assertEqual(active["reviews"][0]["rating"], 4)

    # --- Auth API Tests ---
    def test_register_api(self):
        CustomUser.objects.filter(email="newuser@example.com").delete()

        response = self.client.post(
            reverse("maps:register_api"),
            data=json.dumps(
                {"email": "newuser@example.com", "password": "newpassword123"}
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)

        response2 = self.client.post(
            reverse("maps:register_api"),
            data=json.dumps(
                {"email": "newuser@example.com", "password": "newpassword123"}
            ),
            content_type="application/json",
        )
        self.assertEqual(response2.status_code, 400)

        response3 = self.client.post(
            reverse("maps:register_api"),
            data=json.dumps({"password": "newpassword123"}),
            content_type="application/json",
        )
        self.assertEqual(response3.status_code, 400)

        response4 = self.client.post(
            reverse("maps:register_api"),
            data="not json",
            content_type="application/json",
        )
        self.assertEqual(response4.status_code, 400)

    def test_login_api(self):
        response = self.client.post(
            reverse("maps:login_api"),
            data=json.dumps({"email": "auth@example.com", "password": "password123"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)

        response2 = self.client.post(
            reverse("maps:login_api"),
            data=json.dumps({"email": "auth@example.com", "password": "wrong"}),
            content_type="application/json",
        )
        self.assertEqual(response2.status_code, 401)

        response3 = self.client.post(
            reverse("maps:login_api"), data="not json", content_type="application/json"
        )
        self.assertEqual(response3.status_code, 400)

    def test_logout_api(self):
        self.client.force_login(self.test_user)
        response = self.client.post(reverse("maps:logout_api"))
        self.assertEqual(response.status_code, 200)

    def test_current_user_api(self):
        response = self.client.get(reverse("maps:current_user_api"))
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["is_authenticated"])

        self.client.force_login(self.test_user)
        response2 = self.client.get(reverse("maps:current_user_api"))
        self.assertEqual(response2.status_code, 200)
        self.assertTrue(response2.json()["is_authenticated"])

    # --- Review API Tests ---
    def test_create_review_api(self):
        response = self.client.post(reverse("maps:create_review_api"))
        self.assertEqual(response.status_code, 401)

        self.client.force_login(self.test_user)

        response2 = self.client.post(
            reverse("maps:create_review_api"),
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(response2.status_code, 400)

        response3 = self.client.post(
            reverse("maps:create_review_api"),
            data=json.dumps(
                {
                    "amenity_id": self.amenity_active.id,
                    "rating": 5,
                    "review_text": "Good",
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response3.status_code, 201)

        response4 = self.client.post(
            reverse("maps:create_review_api"),
            data=json.dumps({"amenity_id": self.amenity_active.id, "rating": 4}),
            content_type="application/json",
        )
        self.assertEqual(response4.status_code, 400)

        response_bad_rating = self.client.post(
            reverse("maps:create_review_api"),
            data=json.dumps({"amenity_id": self.amenity_inactive.id, "rating": 6}),
            content_type="application/json",
        )
        self.assertEqual(response_bad_rating.status_code, 400)

        response_bad_json = self.client.post(
            reverse("maps:create_review_api"),
            data="not json",
            content_type="application/json",
        )
        self.assertEqual(response_bad_json.status_code, 400)

        photo = SimpleUploadedFile(
            "test.jpg", b"file_content", content_type="image/jpeg"
        )
        response_file = self.client.post(
            reverse("maps:create_review_api"),
            data={"amenity_id": self.amenity_inactive.id, "rating": 3, "photo": photo},
        )
        self.assertEqual(response_file.status_code, 201)

        bad_photo = SimpleUploadedFile(
            "test.txt", b"content", content_type="text/plain"
        )
        response_bad_file = self.client.post(
            reverse("maps:create_review_api"),
            data={
                "amenity_id": self.amenity_bike_cluster1.id,
                "rating": 3,
                "photo": bad_photo,
            },
        )
        self.assertEqual(response_bad_file.status_code, 400)

        bad_photo.size = 6 * 1024 * 1024
        response_big_file = self.client.post(
            reverse("maps:create_review_api"),
            data={
                "amenity_id": self.amenity_bike_cluster1.id,
                "rating": 3,
                "photo": bad_photo,
            },
        )
        self.assertEqual(response_big_file.status_code, 400)

        response_not_found = self.client.post(
            reverse("maps:create_review_api"),
            data=json.dumps({"amenity_id": 99999, "rating": 3}),
            content_type="application/json",
        )
        self.assertEqual(response_not_found.status_code, 404)
