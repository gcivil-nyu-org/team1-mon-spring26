import json
from django.test import TestCase, Client, override_settings
from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart
from django.urls import reverse
from django.contrib.gis.geos import Point
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils.html import escape
from unittest.mock import patch
from django.utils import timezone
from datetime import timedelta

from maps.models import (
    AmenityType,
    Amenity,
    CustomUser,
    Review,
    AmenityPhoto,
    ReviewVote,
    Favorite,
    Chat,
    ChatParticipant,
    Message,
    AvailabilityReport,
)
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

        self.test_user2, _ = CustomUser.objects.get_or_create(
            username="testauth2",
            email="auth2@example.com",
        )
        self.test_user2.set_password("password123")
        self.test_user2.save()

        self.test_user3, _ = CustomUser.objects.get_or_create(
            username="testauth3",
            email="auth3@example.com",
        )
        self.test_user3.set_password("password123")
        self.test_user3.save()

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
        self.assertContains(response, reverse("google_login"))

    @override_settings(APP_RELEASE="test-release")
    def test_map_view_includes_app_release(self):
        response = self.client.get(reverse("maps:map"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context["app_release"], "test-release")
        self.assertContains(response, 'meta name="app-release" content="test-release"')

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
        self.assertEqual(active["reviews"][0]["user_email"], self.test_user.email)
        self.assertEqual(
            active["reviews"][0]["user_avatar_url"], self.test_user.avatar_url
        )

    def test_avatar_url_falls_back_when_avatar_file_is_missing(self):
        self.test_user.avatar = "avatars/missing-avatar.png"

        with patch.object(self.test_user.avatar.storage, "exists", return_value=False):
            self.assertEqual(
                self.test_user.avatar_url, "/static/maps/default-avatar.svg"
            )

    def test_profile_view_requires_login(self):
        response = self.client.get(reverse("maps:profile"))
        self.assertEqual(response.status_code, 302)
        self.assertIn("/?auth_required=1", response.url)

    def test_profile_view_authenticated(self):
        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:profile"))
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "maps/profile.html")
        self.assertEqual(response.context["profile_user"], self.test_user)
        self.assertEqual(response.context["reviews_count"], 0)
        self.assertEqual(response.context["likes_received_count"], 0)
        self.assertContains(response, "Reviews")
        self.assertContains(response, "Favorites")
        self.assertContains(response, "Settings")

    def test_profile_view_renders_full_bio_text(self):
        bio = "First line\nSecond line with <tags> & symbols"
        self.test_user.bio = bio
        self.test_user.save(update_fields=["bio"])

        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:profile"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, escape(bio), html=True)

    def test_profile_view_includes_review_stats(self):
        Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=5,
            review_text="Helpful review",
        )

        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:profile"))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context["reviews_count"], 1)

    def test_profile_reviews_api_skips_photos_without_file(self):
        review = Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=4,
            review_text="Review with malformed photo row",
        )
        AmenityPhoto.objects.create(
            amenity=self.amenity_active,
            review=review,
            uploaded_by=self.test_user,
            photo="",
        )

        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:profile_reviews_api"))

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data["reviews"]), 1)
        self.assertEqual(data["reviews"][0]["photo_urls"], [])
        self.assertIsNone(data["reviews"][0]["photo_url"])

    def test_profile_favorites_api_requires_login(self):
        response = self.client.get(reverse("maps:profile_favorites_api"))
        self.assertEqual(response.status_code, 302)
        self.assertIn("/?auth_required=1", response.url)

    def test_profile_favorites_api_returns_favorites(self):
        Favorite.objects.create(user=self.test_user, amenity=self.amenity_active)

        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:profile_favorites_api"))
        self.assertEqual(response.status_code, 200)

        data = response.json()
        self.assertIn("favorites", data)
        self.assertEqual(len(data["favorites"]), 1)
        self.assertEqual(data["favorites"][0]["amenity_id"], self.amenity_active.id)
        self.assertTrue(data["favorites"][0]["notify_on_updates"])

    def test_favorite_notification_preference_api_updates_flag(self):
        favorite = Favorite.objects.create(
            user=self.test_user, amenity=self.amenity_active
        )

        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:favorite_notification_preference_api", args=[favorite.id]),
            data=json.dumps({"notify_on_updates": False}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)

        favorite.refresh_from_db()
        self.assertFalse(favorite.notify_on_updates)

    def test_favorite_notification_preference_api_rejects_non_boolean(self):
        favorite = Favorite.objects.create(
            user=self.test_user, amenity=self.amenity_active
        )

        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:favorite_notification_preference_api", args=[favorite.id]),
            data=json.dumps({"notify_on_updates": "yes"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_toggle_favorite_api_add_and_remove(self):
        self.client.force_login(self.test_user)

        add_response = self.client.post(
            reverse("maps:toggle_favorite_api", args=[self.amenity_active.id])
        )
        self.assertEqual(add_response.status_code, 200)
        self.assertTrue(
            Favorite.objects.filter(
                user=self.test_user,
                amenity=self.amenity_active,
            ).exists()
        )

        remove_response = self.client.delete(
            reverse("maps:toggle_favorite_api", args=[self.amenity_active.id])
        )
        self.assertEqual(remove_response.status_code, 200)
        self.assertFalse(
            Favorite.objects.filter(
                user=self.test_user,
                amenity=self.amenity_active,
            ).exists()
        )

    def test_amenities_api_marks_favorited_amenities(self):
        Favorite.objects.create(user=self.test_user, amenity=self.amenity_active)

        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:amenities_api"))
        self.assertEqual(response.status_code, 200)

        data = response.json()
        active = next(
            (a for a in data["amenities"] if a.get("id") == self.amenity_active.id),
            None,
        )
        self.assertIsNotNone(active)
        self.assertTrue(active.get("is_favorited"))

    def test_amenity_detail_api_returns_amenity(self):
        self.client.force_login(self.test_user)
        response = self.client.get(
            reverse("maps:amenity_detail_api", args=[self.amenity_active.id])
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("amenity", data)
        self.assertEqual(data["amenity"]["id"], self.amenity_active.id)

    def test_settings_view_requires_login(self):
        response = self.client.get(reverse("maps:settings"))
        self.assertEqual(response.status_code, 302)
        self.assertIn("/?auth_required=1", response.url)

    def test_settings_view_authenticated(self):
        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:settings"))
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "maps/settings.html")
        self.assertEqual(response.context["profile_user"], self.test_user)
        self.assertContains(response, "Profile")
        self.assertContains(response, "Account")
        self.assertContains(response, "Notifications")

    def test_update_profile_api_updates_profile(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:update_profile_api"),
            data={"username": "updated-name", "bio": "Updated bio"},
        )
        self.assertEqual(response.status_code, 200)

        self.test_user.refresh_from_db()
        self.assertEqual(self.test_user.username, "updated-name")
        self.assertEqual(self.test_user.bio, "Updated bio")

        body = response.json()
        self.assertEqual(body["username"], "updated-name")
        self.assertEqual(body["bio"], "Updated bio")

    def test_update_profile_api_rejects_blank_username(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:update_profile_api"),
            data={"username": "   ", "bio": "Updated bio"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Username is required")

    def test_update_profile_api_rejects_bio_longer_than_150_chars(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:update_profile_api"),
            data={"username": "updated-name", "bio": "a" * 151},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"],
            "Bio must be 150 characters or fewer",
        )

    def test_change_password_api_updates_password_and_keeps_session(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:change_password_api"),
            data={
                "current_password": "password123",
                "new_password": "new-password-456",
                "confirm_password": "new-password-456",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["message"], "Password updated successfully")

        self.test_user.refresh_from_db()
        self.assertTrue(self.test_user.check_password("new-password-456"))

        current_user_response = self.client.get(reverse("maps:current_user_api"))
        self.assertEqual(current_user_response.status_code, 200)
        self.assertTrue(current_user_response.json()["is_authenticated"])

    def test_change_password_api_rejects_wrong_current_password(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:change_password_api"),
            data={
                "current_password": "wrong-password",
                "new_password": "new-password-456",
                "confirm_password": "new-password-456",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Current password is incorrect")

    def test_change_password_api_rejects_confirmation_mismatch(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:change_password_api"),
            data={
                "current_password": "password123",
                "new_password": "new-password-456",
                "confirm_password": "different-password-789",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"],
            "New password and confirmation do not match",
        )

    def test_change_password_api_sets_password_for_social_only_user(self):
        social_user = CustomUser.objects.create(
            username="google-only",
            email="google-only@example.com",
        )
        social_user.set_unusable_password()
        social_user.save(update_fields=["password"])

        self.client.force_login(social_user)
        response = self.client.post(
            reverse("maps:change_password_api"),
            data={
                "new_password": "brand-new-password-456",
                "confirm_password": "brand-new-password-456",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["message"], "Password set successfully")
        self.assertTrue(response.json()["has_usable_password"])
        self.assertEqual(response.json()["password_action"], "set")

        social_user.refresh_from_db()
        self.assertTrue(social_user.check_password("brand-new-password-456"))

    def test_password_reset_sends_email_for_user_with_usable_password(self):
        response = self.client.post(
            reverse("password_reset"),
            data={"email": self.test_user.email},
        )
        self.assertRedirects(response, reverse("password_reset_done"))
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [self.test_user.email])

    def test_password_reset_does_not_email_social_only_user(self):
        social_user = CustomUser.objects.create(
            username="google-reset-only",
            email="google-reset-only@example.com",
        )
        social_user.set_unusable_password()
        social_user.save(update_fields=["password"])

        response = self.client.post(
            reverse("password_reset"),
            data={"email": social_user.email},
        )
        self.assertRedirects(response, reverse("password_reset_done"))
        self.assertEqual(len(mail.outbox), 0)

    def test_profile_reviews_api_returns_current_users_reviews(self):
        other_user = CustomUser.objects.create_user(
            email="other@example.com",
            username="other-user",
            password="password123",
        )
        own_review = Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=5,
            review_text="My review",
        )
        Review.objects.create(
            amenity=self.amenity_inactive,
            user=other_user,
            rating=3,
            review_text="Someone else's review",
        )
        photo = SimpleUploadedFile(
            "profile-review.jpg", b"file_content", content_type="image/jpeg"
        )
        photo2 = SimpleUploadedFile(
            "profile-review-2.jpg", b"file_content_2", content_type="image/jpeg"
        )
        first_photo = AmenityPhoto.objects.create(
            amenity=self.amenity_active,
            uploaded_by=self.test_user,
            photo=photo,
            review=own_review,
        )
        second_photo = AmenityPhoto.objects.create(
            amenity=self.amenity_active,
            uploaded_by=self.test_user,
            photo=photo2,
            review=own_review,
        )

        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:profile_reviews_api"))
        self.assertEqual(response.status_code, 200)

        reviews = response.json()["reviews"]
        self.assertEqual(len(reviews), 1)
        self.assertEqual(reviews[0]["id"], own_review.id)
        self.assertEqual(reviews[0]["amenity_name"], self.amenity_active.name)
        self.assertEqual(
            reviews[0]["amenity_prop_name"],
            self.amenity_active.prop_name,
        )
        self.assertEqual(
            reviews[0]["amenity_type"], self.amenity_active.amenity_type.name
        )
        self.assertIsNotNone(reviews[0]["photo_id"])
        self.assertIsNotNone(reviews[0]["photo_url"])
        self.assertEqual(len(reviews[0]["photo_ids"]), 2)
        self.assertCountEqual(
            reviews[0]["photo_ids"], [first_photo.id, second_photo.id]
        )
        self.assertEqual(len(reviews[0]["photo_urls"]), 2)
        self.assertEqual(reviews[0]["vote_score"], 0)

    def test_profile_reviews_api_returns_vote_score(self):
        review = Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=5,
            review_text="My review",
        )
        ReviewVote.objects.create(review=review, user=self.test_user2, value=1)
        ReviewVote.objects.create(review=review, user=self.test_user3, value=1)

        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:profile_reviews_api"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["reviews"][0]["vote_score"], 2)

    def test_review_detail_api_patch_updates_own_review(self):
        review = Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=4,
            review_text="Original",
        )

        self.client.force_login(self.test_user)
        response = self.client.patch(
            reverse("maps:review_detail_api", args=[review.id]),
            data=json.dumps({"rating": 5, "review_text": "Updated"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)

        review.refresh_from_db()
        self.assertEqual(review.rating, 5)
        self.assertEqual(review.review_text, "Updated")
        self.assertEqual(response.json()["message"], "Review updated successfully")

    def test_review_detail_api_patch_accepts_multipart_and_adds_photos(self):
        review = Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=4,
            review_text="Original",
        )
        photo1 = SimpleUploadedFile(
            "review-photo-1.jpg", b"file_content_1", content_type="image/jpeg"
        )
        photo2 = SimpleUploadedFile(
            "review-photo-2.jpg", b"file_content_2", content_type="image/jpeg"
        )
        payload = encode_multipart(
            BOUNDARY,
            {
                "rating": "5",
                "review_text": "Updated with photos",
                "photos": [photo1, photo2],
            },
        )

        self.client.force_login(self.test_user)
        response = self.client.generic(
            "PATCH",
            reverse("maps:review_detail_api", args=[review.id]),
            payload,
            content_type=MULTIPART_CONTENT,
        )
        self.assertEqual(response.status_code, 200)

        review.refresh_from_db()
        self.assertEqual(review.rating, 5)
        self.assertEqual(review.review_text, "Updated with photos")
        self.assertEqual(
            AmenityPhoto.objects.filter(
                review=review, uploaded_by=self.test_user
            ).count(),
            2,
        )
        self.assertEqual(len(response.json()["photo_urls"]), 2)
        self.assertEqual(response.json()["vote_score"], 0)

    def test_review_detail_api_delete_removes_own_review(self):
        review = Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=4,
            review_text="Original",
        )

        self.client.force_login(self.test_user)
        response = self.client.delete(
            reverse("maps:review_detail_api", args=[review.id])
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(Review.objects.filter(id=review.id).exists())

    def test_review_photo_detail_api_delete_removes_photo_but_keeps_review(self):
        review = Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=4,
            review_text="Original",
        )
        photo = SimpleUploadedFile(
            "review-photo.jpg", b"file_content", content_type="image/jpeg"
        )
        review_photo = AmenityPhoto.objects.create(
            amenity=self.amenity_active,
            uploaded_by=self.test_user,
            photo=photo,
            review=review,
        )

        self.client.force_login(self.test_user)
        response = self.client.delete(
            reverse(
                "maps:review_photo_detail_api",
                args=[review.id, review_photo.id],
            )
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(Review.objects.filter(id=review.id).exists())
        self.assertFalse(AmenityPhoto.objects.filter(id=review_photo.id).exists())

    def test_review_photo_detail_api_delete_handles_legacy_unlinked_photo(self):
        review = Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=5,
            review_text="Legacy photo review",
        )
        photo = SimpleUploadedFile(
            "legacy-review-photo.jpg", b"file_content", content_type="image/jpeg"
        )
        legacy_photo = AmenityPhoto.objects.create(
            amenity=self.amenity_active,
            uploaded_by=self.test_user,
            photo=photo,
            review=None,
        )

        self.client.force_login(self.test_user)
        response = self.client.delete(
            reverse(
                "maps:review_photo_detail_api",
                args=[review.id, legacy_photo.id],
            )
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(Review.objects.filter(id=review.id).exists())
        self.assertFalse(AmenityPhoto.objects.filter(id=legacy_photo.id).exists())

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
        self.assertFalse(response.json()["has_usable_password"])

        self.client.force_login(self.test_user)
        response2 = self.client.get(reverse("maps:current_user_api"))
        self.assertEqual(response2.status_code, 200)
        self.assertTrue(response2.json()["is_authenticated"])
        self.assertTrue(response2.json()["has_usable_password"])

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
            data={"amenity_id": self.amenity_inactive.id, "rating": 3, "photos": photo},
        )
        self.assertEqual(response_file.status_code, 201)

        # Test multiple photos
        photo1 = SimpleUploadedFile(
            "test1.jpg", b"file_content1", content_type="image/jpeg"
        )
        photo2 = SimpleUploadedFile(
            "test2.jpg", b"file_content2", content_type="image/jpeg"
        )
        response_multiple = self.client.post(
            reverse("maps:create_review_api"),
            data={
                "amenity_id": self.amenity_bike_cluster1.id,
                "rating": 4,
                "photos": [photo1, photo2],
            },
        )
        self.assertEqual(response_multiple.status_code, 201)

        bad_photo = SimpleUploadedFile(
            "test.txt", b"content", content_type="text/plain"
        )
        response_bad_file = self.client.post(
            reverse("maps:create_review_api"),
            data={
                "amenity_id": self.amenity_bike_cluster1.id,
                "rating": 3,
                "photos": bad_photo,
            },
        )
        self.assertEqual(response_bad_file.status_code, 400)

        bad_photo.size = 6 * 1024 * 1024
        response_big_file = self.client.post(
            reverse("maps:create_review_api"),
            data={
                "amenity_id": self.amenity_bike_cluster1.id,
                "rating": 3,
                "photos": bad_photo,
            },
        )
        self.assertEqual(response_big_file.status_code, 400)

        too_many_photos = [
            SimpleUploadedFile(
                f"img{i}.jpg", b"file_content", content_type="image/jpeg"
            )
            for i in range(6)
        ]
        response_too_many = self.client.post(
            reverse("maps:create_review_api"),
            data={
                "amenity_id": self.amenity_bike_cluster2.id,
                "rating": 4,
                "photos": too_many_photos,
            },
        )
        self.assertEqual(response_too_many.status_code, 400)

        response_not_found = self.client.post(
            reverse("maps:create_review_api"),
            data=json.dumps({"amenity_id": 99999, "rating": 3}),
            content_type="application/json",
        )
        self.assertEqual(response_not_found.status_code, 404)

    def test_review_vote_api_toggle_and_change(self):
        reviewer = CustomUser.objects.create_user(
            email="reviewer@example.com",
            username="reviewer",
            password="password123",
        )
        review = Review.objects.create(
            amenity=self.amenity_active,
            user=reviewer,
            rating=4,
            review_text="Solid spot",
        )

        self.client.force_login(self.test_user)

        first = self.client.post(
            reverse("maps:review_vote_api", args=[review.id]),
            data=json.dumps({"vote": "up"}),
            content_type="application/json",
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["vote_score"], 1)
        self.assertEqual(first.json()["user_vote"], 1)

        second = self.client.post(
            reverse("maps:review_vote_api", args=[review.id]),
            data=json.dumps({"vote": "up"}),
            content_type="application/json",
        )
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["vote_score"], 0)
        self.assertEqual(second.json()["user_vote"], 0)

        third = self.client.post(
            reverse("maps:review_vote_api", args=[review.id]),
            data=json.dumps({"vote": "down"}),
            content_type="application/json",
        )
        self.assertEqual(third.status_code, 200)
        self.assertEqual(third.json()["vote_score"], -1)
        self.assertEqual(third.json()["user_vote"], -1)

    def test_amenities_api_returns_vote_score_ordering(self):
        reviewer_one = CustomUser.objects.create_user(
            email="reviewer1@example.com",
            username="reviewer-one",
            password="password123",
        )
        reviewer_two = CustomUser.objects.create_user(
            email="reviewer2@example.com",
            username="reviewer-two",
            password="password123",
        )

        review_top = Review.objects.create(
            amenity=self.amenity_active,
            user=reviewer_one,
            rating=3,
            review_text="Top-voted",
        )
        review_low = Review.objects.create(
            amenity=self.amenity_active,
            user=reviewer_two,
            rating=5,
            review_text="Lower votes",
        )

        voter_a = CustomUser.objects.create_user(
            email="votera@example.com",
            username="voter-a",
            password="password123",
        )
        voter_b = CustomUser.objects.create_user(
            email="voterb@example.com",
            username="voter-b",
            password="password123",
        )

        ReviewVote.objects.create(review=review_top, user=voter_a, value=1)
        ReviewVote.objects.create(review=review_top, user=voter_b, value=1)
        ReviewVote.objects.create(review=review_low, user=voter_a, value=-1)

        self.client.force_login(voter_b)
        response = self.client.get(reverse("maps:amenities_api"))
        self.assertEqual(response.status_code, 200)

        payload = response.json()["amenities"]
        amenity_payload = next(
            item for item in payload if item.get("id") == self.amenity_active.id
        )

        self.assertGreaterEqual(len(amenity_payload["reviews"]), 2)
        first_review = amenity_payload["reviews"][0]
        self.assertEqual(first_review["id"], review_top.id)
        self.assertEqual(first_review["vote_score"], 2)

    # --- Get Amenity Reviews API ---
    def test_get_amenity_reviews_api_no_id(self):
        response = self.client.get(reverse("maps:get_amenity_reviews_api"))
        self.assertEqual(response.status_code, 400)

    def test_get_amenity_reviews_api_not_found(self):
        response = self.client.get(
            reverse("maps:get_amenity_reviews_api"), {"amenity_id": 99999}
        )
        self.assertEqual(response.status_code, 404)

    def test_get_amenity_reviews_api_success(self):
        Review.objects.get_or_create(
            amenity=self.amenity_active,
            user=self.test_user,
            defaults={"rating": 4, "review_text": "Good"},
        )
        response = self.client.get(
            reverse("maps:get_amenity_reviews_api"),
            {"amenity_id": self.amenity_active.id},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("reviews", data)
        self.assertIn("total_reviews", data)

    def test_get_amenity_reviews_api_pagination(self):
        response = self.client.get(
            reverse("maps:get_amenity_reviews_api"),
            {"amenity_id": self.amenity_active.id, "page": 1, "page_size": 5},
        )
        self.assertEqual(response.status_code, 200)

    def test_get_amenity_reviews_api_invalid_page(self):
        response = self.client.get(
            reverse("maps:get_amenity_reviews_api"),
            {"amenity_id": self.amenity_active.id, "page": "abc"},
        )
        self.assertEqual(response.status_code, 400)

    # --- Amenity Search API ---
    def test_amenity_search_api_short_query(self):
        response = self.client.get(reverse("maps:amenity_search_api"), {"q": "a"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["amenities"], [])

    def test_amenity_search_api_returns_results(self):
        response = self.client.get(
            reverse("maps:amenity_search_api"), {"q": "Active Test"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(len(response.json()["amenities"]) >= 1)

    def test_amenity_search_api_no_results(self):
        response = self.client.get(
            reverse("maps:amenity_search_api"), {"q": "zzznomatch"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["amenities"], [])

    # --- Amenity Reviewers API ---
    def test_get_amenity_reviewers_api_no_id(self):
        response = self.client.get(reverse("maps:get_amenity_reviewers_api"))
        self.assertEqual(response.status_code, 400)

    def test_get_amenity_reviewers_api_not_found(self):
        response = self.client.get(
            reverse("maps:get_amenity_reviewers_api"), {"amenity_id": 99999}
        )
        self.assertEqual(response.status_code, 404)

    def test_get_amenity_reviewers_api_success(self):
        Review.objects.get_or_create(
            amenity=self.amenity_active,
            user=self.test_user,
            defaults={"rating": 5, "review_text": "Great"},
        )
        response = self.client.get(
            reverse("maps:get_amenity_reviewers_api"),
            {"amenity_id": self.amenity_active.id},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("reviewers", data)
        self.assertEqual(data["amenity_id"], self.amenity_active.id)

    def test_get_amenity_reviewers_api_invalid_limit(self):
        response = self.client.get(
            reverse("maps:get_amenity_reviewers_api"),
            {"amenity_id": self.amenity_active.id, "limit": "abc"},
        )
        self.assertEqual(response.status_code, 400)

    # --- Get User Chats API ---
    def test_get_user_chats_unauthenticated(self):
        response = self.client.get(reverse("maps:get_user_chats_api"))
        self.assertEqual(response.status_code, 401)

    def test_get_user_chats_empty(self):
        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:get_user_chats_api"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["total_count"], 0)

    def test_get_user_chats_returns_participant_chats(self):
        self.client.force_login(self.test_user)
        chat = Chat.objects.create(chat_type="direct", created_by=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user2)
        response = self.client.get(reverse("maps:get_user_chats_api"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["total_count"], 1)

    def test_get_user_chats_with_last_message(self):
        self.client.force_login(self.test_user)
        chat = Chat.objects.create(chat_type="direct", created_by=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user2)
        Message.objects.create(chat=chat, sender=self.test_user, content="Hey!")
        response = self.client.get(reverse("maps:get_user_chats_api"))
        self.assertEqual(response.json()["chats"][0]["last_message"], "Hey!")

    # --- Get Chat Messages API ---
    def test_get_chat_messages_unauthenticated(self):
        response = self.client.get(reverse("maps:get_chat_messages_api"))
        self.assertEqual(response.status_code, 401)

    def test_get_chat_messages_missing_chat_id(self):
        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:get_chat_messages_api"))
        self.assertEqual(response.status_code, 400)

    def test_get_chat_messages_not_found(self):
        self.client.force_login(self.test_user)
        response = self.client.get(
            reverse("maps:get_chat_messages_api"), {"chat_id": 99999}
        )
        self.assertEqual(response.status_code, 404)

    def test_get_chat_messages_not_participant(self):
        self.client.force_login(self.test_user3)
        chat = Chat.objects.create(chat_type="direct", created_by=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user2)
        response = self.client.get(
            reverse("maps:get_chat_messages_api"), {"chat_id": chat.id}
        )
        self.assertEqual(response.status_code, 403)

    def test_get_chat_messages_success(self):
        self.client.force_login(self.test_user)
        chat = Chat.objects.create(chat_type="direct", created_by=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user2)
        Message.objects.create(chat=chat, sender=self.test_user, content="First")
        Message.objects.create(chat=chat, sender=self.test_user2, content="Second")
        response = self.client.get(
            reverse("maps:get_chat_messages_api"), {"chat_id": chat.id}
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["total_messages"], 2)
        self.assertEqual(data["messages"][0]["content"], "First")

    def test_get_chat_messages_invalid_page(self):
        self.client.force_login(self.test_user)
        chat = Chat.objects.create(chat_type="direct", created_by=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user)
        response = self.client.get(
            reverse("maps:get_chat_messages_api"),
            {"chat_id": chat.id, "page": "abc"},
        )
        self.assertEqual(response.status_code, 400)

    # --- Send Message API ---
    def test_send_message_unauthenticated(self):
        response = self.client.post(
            reverse("maps:send_message_api"),
            data=json.dumps({"chat_id": 1, "content": "Hi"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)

    def test_send_message_missing_chat_id(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:send_message_api"),
            data=json.dumps({"content": "Hi"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_send_message_empty_content(self):
        self.client.force_login(self.test_user)
        chat = Chat.objects.create(chat_type="direct", created_by=self.test_user)
        response = self.client.post(
            reverse("maps:send_message_api"),
            data=json.dumps({"chat_id": chat.id, "content": "  "}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_send_message_chat_not_found(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:send_message_api"),
            data=json.dumps({"chat_id": 99999, "content": "Hi"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_send_message_not_participant(self):
        self.client.force_login(self.test_user3)
        chat = Chat.objects.create(chat_type="direct", created_by=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user2)
        response = self.client.post(
            reverse("maps:send_message_api"),
            data=json.dumps({"chat_id": chat.id, "content": "Hi"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    def test_send_message_success(self):
        self.client.force_login(self.test_user)
        chat = Chat.objects.create(chat_type="direct", created_by=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user)
        ChatParticipant.objects.create(chat=chat, user=self.test_user2)
        response = self.client.post(
            reverse("maps:send_message_api"),
            data=json.dumps({"chat_id": chat.id, "content": "Hello!"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["content"], "Hello!")
        self.assertEqual(response.json()["sender_email"], self.test_user.email)

    def test_send_message_invalid_json(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:send_message_api"),
            data="not json",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    # --- Create Direct Chat API ---
    def test_create_direct_chat_unauthenticated(self):
        response = self.client.post(
            reverse("maps:create_direct_chat_api"),
            data=json.dumps({"recipient_email": self.test_user2.email}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)

    def test_create_direct_chat_missing_recipient(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_direct_chat_api"),
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_direct_chat_recipient_not_found(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_direct_chat_api"),
            data=json.dumps({"recipient_email": "nobody@example.com"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_create_direct_chat_with_self(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_direct_chat_api"),
            data=json.dumps({"recipient_email": self.test_user.email}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_direct_chat_success(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_direct_chat_api"),
            data=json.dumps({"recipient_email": self.test_user2.email}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertEqual(data["chat_type"], "direct")
        chat = Chat.objects.get(id=data["id"])
        self.assertTrue(chat.participants.filter(user=self.test_user).exists())
        self.assertTrue(chat.participants.filter(user=self.test_user2).exists())

    def test_create_direct_chat_existing_returns_200(self):
        self.client.force_login(self.test_user)
        existing = Chat.objects.create(chat_type="direct", created_by=self.test_user)
        ChatParticipant.objects.create(chat=existing, user=self.test_user)
        ChatParticipant.objects.create(chat=existing, user=self.test_user2)
        response = self.client.post(
            reverse("maps:create_direct_chat_api"),
            data=json.dumps({"recipient_email": self.test_user2.email}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], existing.id)

    def test_create_direct_chat_invalid_json(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_direct_chat_api"),
            data="not json",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    # --- Create Group Chat API ---
    def test_create_group_chat_unauthenticated(self):
        response = self.client.post(
            reverse("maps:create_group_chat_api"),
            data=json.dumps(
                {
                    "chat_name": "Test",
                    "participant_emails": [
                        self.test_user2.email,
                        self.test_user3.email,
                    ],
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)

    def test_create_group_chat_missing_name(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_group_chat_api"),
            data=json.dumps(
                {
                    "participant_emails": [
                        self.test_user2.email,
                        self.test_user3.email,
                    ],
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_group_chat_missing_participants(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_group_chat_api"),
            data=json.dumps({"chat_name": "Test Group"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_group_chat_participant_not_found(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_group_chat_api"),
            data=json.dumps(
                {
                    "chat_name": "Test Group",
                    "participant_emails": [self.test_user2.email, "ghost@example.com"],
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_create_group_chat_success(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_group_chat_api"),
            data=json.dumps(
                {
                    "chat_name": "My Group",
                    "participant_emails": [
                        self.test_user2.email,
                        self.test_user3.email,
                    ],
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertEqual(data["chat_type"], "group")
        self.assertEqual(data["name"], "My Group")
        self.assertTrue(
            Chat.objects.get(id=data["id"])
            .participants.filter(user=self.test_user)
            .exists()
        )

    def test_create_group_chat_with_amenity(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_group_chat_api"),
            data=json.dumps(
                {
                    "chat_name": "Park Chat",
                    "participant_emails": [
                        self.test_user2.email,
                        self.test_user3.email,
                    ],
                    "amenity_id": self.amenity_active.id,
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["chat_type"], "amenity_forum")

    def test_create_group_chat_amenity_not_found(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_group_chat_api"),
            data=json.dumps(
                {
                    "chat_name": "Park Chat",
                    "participant_emails": [
                        self.test_user2.email,
                        self.test_user3.email,
                    ],
                    "amenity_id": 99999,
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_create_group_chat_invalid_json(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:create_group_chat_api"),
            data="not json",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    # --- chats_view requires login ---
    def test_chats_view_requires_login(self):
        response = self.client.get(reverse("maps:chats"))
        self.assertEqual(response.status_code, 302)
        self.assertIn("/?auth_required=1", response.url)

    def test_chats_view_authenticated(self):
        self.client.force_login(self.test_user)
        response = self.client.get(reverse("maps:chats"))
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "maps/chats.html")

    # --- update_profile_api missing branches ---
    def test_update_profile_api_rejects_username_too_long(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:update_profile_api"),
            data={"username": "a" * 31, "bio": ""},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"], "Username must be 30 characters or fewer"
        )

    def test_update_profile_api_rejects_taken_username(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:update_profile_api"),
            data={"username": self.test_user2.username, "bio": ""},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Username is already taken")

    def test_update_profile_api_rejects_non_image_avatar(self):
        self.client.force_login(self.test_user)
        bad_file = SimpleUploadedFile(
            "doc.pdf", b"content", content_type="application/pdf"
        )
        response = self.client.post(
            reverse("maps:update_profile_api"),
            data={"username": "validname", "bio": "", "avatar": bad_file},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Avatar must be an image")

    def test_update_profile_api_rejects_avatar_too_large(self):
        self.client.force_login(self.test_user)
        big_file = SimpleUploadedFile(
            "big.jpg", b"x" * (3 * 1024 * 1024), content_type="image/jpeg"
        )
        response = self.client.post(
            reverse("maps:update_profile_api"),
            data={"username": "validname2", "bio": "", "avatar": big_file},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Avatar must be 2MB or smaller")

    def test_update_profile_api_accepts_valid_avatar(self):
        self.client.force_login(self.test_user)
        avatar = SimpleUploadedFile("avatar.jpg", b"imgdata", content_type="image/jpeg")
        response = self.client.post(
            reverse("maps:update_profile_api"),
            data={"username": "avataruser", "bio": "hi", "avatar": avatar},
        )
        self.assertEqual(response.status_code, 200)
        self.test_user.refresh_from_db()
        self.assertTrue(bool(self.test_user.avatar))

    # --- change_password_api missing branches ---
    def test_change_password_api_rejects_blank_fields(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:change_password_api"),
            data={"current_password": "", "new_password": "", "confirm_password": ""},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "All password fields are required")

    def test_change_password_api_rejects_same_as_current(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:change_password_api"),
            data={
                "current_password": "password123",
                "new_password": "password123",
                "confirm_password": "password123",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"],
            "New password must be different from your current password",
        )

    def test_change_password_api_social_only_user_requires_new_password_fields(self):
        social_user = CustomUser.objects.create(
            username="google-blank",
            email="google-blank@example.com",
        )
        social_user.set_unusable_password()
        social_user.save(update_fields=["password"])

        self.client.force_login(social_user)
        response = self.client.post(
            reverse("maps:change_password_api"),
            data={"new_password": "", "confirm_password": ""},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"],
            "New password and confirmation are required",
        )

    # --- review_vote_api missing branches ---
    def test_review_vote_api_own_review_rejected(self):
        review = Review.objects.create(
            amenity=self.amenity_active,
            user=self.test_user,
            rating=4,
            review_text="My own",
        )
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:review_vote_api", args=[review.id]),
            data=json.dumps({"vote": "up"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "You cannot vote on your own review")

    def test_review_vote_api_review_not_found(self):
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:review_vote_api", args=[99999]),
            data=json.dumps({"vote": "up"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_review_vote_api_invalid_vote_value(self):
        reviewer = CustomUser.objects.create_user(
            email="votetest@example.com", username="votetest", password="pw"
        )
        review = Review.objects.create(
            amenity=self.amenity_active, user=reviewer, rating=3, review_text="ok"
        )
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:review_vote_api", args=[review.id]),
            data=json.dumps({"vote": "sideways"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_review_vote_api_clear_vote(self):
        reviewer = CustomUser.objects.create_user(
            email="clearvote@example.com", username="clearvote", password="pw"
        )
        review = Review.objects.create(
            amenity=self.amenity_active, user=reviewer, rating=3, review_text="ok"
        )
        self.client.force_login(self.test_user)
        self.client.post(
            reverse("maps:review_vote_api", args=[review.id]),
            data=json.dumps({"vote": "up"}),
            content_type="application/json",
        )
        response = self.client.post(
            reverse("maps:review_vote_api", args=[review.id]),
            data=json.dumps({"vote": "clear"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user_vote"], 0)

    def test_review_vote_api_change_from_down_to_up(self):
        reviewer = CustomUser.objects.create_user(
            email="changevote@example.com", username="changevote", password="pw"
        )
        review = Review.objects.create(
            amenity=self.amenity_active, user=reviewer, rating=3, review_text="ok"
        )
        self.client.force_login(self.test_user)
        self.client.post(
            reverse("maps:review_vote_api", args=[review.id]),
            data=json.dumps({"vote": "down"}),
            content_type="application/json",
        )
        response = self.client.post(
            reverse("maps:review_vote_api", args=[review.id]),
            data=json.dumps({"vote": "up"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user_vote"], 1)

    def test_review_vote_api_invalid_json(self):
        reviewer = CustomUser.objects.create_user(
            email="votejson@example.com", username="votejson", password="pw"
        )
        review = Review.objects.create(
            amenity=self.amenity_active, user=reviewer, rating=3, review_text="ok"
        )
        self.client.force_login(self.test_user)
        response = self.client.post(
            reverse("maps:review_vote_api", args=[review.id]),
            data="not json",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    # --- review_detail_api missing branches ---
    def test_review_detail_api_not_found(self):
        self.client.force_login(self.test_user)
        response = self.client.patch(
            reverse("maps:review_detail_api", args=[99999]),
            data=json.dumps({"rating": 3, "review_text": "x"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_review_detail_api_patch_rejects_invalid_rating(self):
        review = Review.objects.create(
            amenity=self.amenity_active, user=self.test_user, rating=3, review_text="ok"
        )
        self.client.force_login(self.test_user)
        response = self.client.patch(
            reverse("maps:review_detail_api", args=[review.id]),
            data=json.dumps({"rating": 6, "review_text": "Updated"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_review_detail_api_patch_rejects_long_review_text(self):
        review = Review.objects.create(
            amenity=self.amenity_active, user=self.test_user, rating=3, review_text="ok"
        )
        self.client.force_login(self.test_user)
        response = self.client.patch(
            reverse("maps:review_detail_api", args=[review.id]),
            data=json.dumps({"rating": 3, "review_text": "a" * 601}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"], "Review text must be 600 characters or fewer"
        )

    # --- amenity_detail_api not found ---
    def test_amenity_detail_api_not_found(self):
        response = self.client.get(reverse("maps:amenity_detail_api", args=[99999]))
        self.assertEqual(response.status_code, 404)

    # --- fix: total_count key name in get_amenity_reviews_api ---
    def test_get_amenity_reviews_api_returns_total_reviews_key(self):
        response = self.client.get(
            reverse("maps:get_amenity_reviews_api"),
            {"amenity_id": self.amenity_active.id},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("total_reviews", data)

    def test_get_availability_status_empty(self):
        response = self.client.get(
            f"/api/amenities/{self.amenity_active.id}/availability/"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["available"], 0)
        self.assertEqual(data["unavailable"], 0)
        self.assertEqual(data["total"], 0)
        self.assertIsNone(data["user_vote"])

    def test_post_availability_report(self):
        response = self.client.post(
            f"/api/amenities/{self.amenity_active.id}/availability/report/",
            data='{"is_available": true}',
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["available"], 1)
        self.assertEqual(data["unavailable"], 0)
        self.assertEqual(data["user_vote"], "available")
        self.assertEqual(AvailabilityReport.objects.count(), 1)

    def test_change_availability_vote(self):
        self.client.post(
            f"/api/amenities/{self.amenity_active.id}/availability/report/",
            data='{"is_available": true}',
            content_type="application/json",
        )
        self.client.post(
            f"/api/amenities/{self.amenity_active.id}/availability/report/",
            data='{"is_available": false}',
            content_type="application/json",
        )
        self.assertEqual(AvailabilityReport.objects.count(), 1)
        self.assertFalse(AvailabilityReport.objects.first().is_available)

    def test_expired_availability_reports_excluded(self):
        report = AvailabilityReport.objects.create(
            amenity=self.amenity_active,
            is_available=True,
            session_key="old-session",
        )
        old_time = timezone.now() - timedelta(hours=4)
        AvailabilityReport.objects.filter(pk=report.pk).update(reported_at=old_time)
        response = self.client.get(
            f"/api/amenities/{self.amenity_active.id}/availability/"
        )
        self.assertEqual(response.json()["total"], 0)

    def test_availability_invalid_amenity_returns_404(self):
        response = self.client.get("/api/amenities/99999/availability/")
        self.assertEqual(response.status_code, 404)

    def test_availability_missing_is_available_field(self):
        response = self.client.post(
            f"/api/amenities/{self.amenity_active.id}/availability/report/",
            data="{}",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
