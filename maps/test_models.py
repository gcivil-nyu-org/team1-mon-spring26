from django.test import TestCase
from django.contrib.auth import get_user_model
from django.contrib.gis.geos import Point
import datetime

from maps.models import AmenityType, Amenity, Review, AmenityPhoto, Favorite

User = get_user_model()


class ModelsCoverageTest(TestCase):
    def setUp(self):
        self.user, _ = User.objects.get_or_create(
            username="modeluser",
            email="model@example.com",
            defaults={"password": "password123"},
        )

        self.type_parent, _ = AmenityType.objects.get_or_create(name="Parent Type")
        self.type_child, _ = AmenityType.objects.get_or_create(
            name="Child Type", parent=self.type_parent
        )

        self.amenity, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_parent,
            external_id="test_model_am",
            defaults={
                "name": "Test Amenity",
                "location": Point(-73.0, 40.0),
                "active": True,
            },
        )

        self.amenity_inactive, _ = Amenity.objects.get_or_create(
            amenity_type=self.type_parent,
            external_id="test_model_am_in",
            defaults={
                "name": "Inactive Amenity",
                "location": Point(-73.0, 40.0),
                "active": False,
            },
        )

    def test_custom_user_str(self):
        self.assertEqual(str(self.user), "model@example.com")

    def test_amenity_type_str(self):
        self.assertEqual(str(self.type_parent), "Parent Type")
        self.assertEqual(str(self.type_child), "Parent Type -> Child Type")

    def test_amenity_str(self):
        self.assertEqual(str(self.amenity), "Test Amenity (Parent Type)")
        self.assertEqual(
            str(self.amenity_inactive), "Inactive Amenity (Parent Type) (Inactive)"
        )

    def test_amenity_get_todays_hours(self):
        self.amenity.is_open_24hrs = True
        self.amenity.save()
        open_t, close_t = self.amenity.get_todays_hours()
        self.assertEqual(open_t, datetime.time(0, 0))
        self.assertEqual(close_t, datetime.time(0, 0))

        self.amenity.is_open_24hrs = False
        self.amenity.monday_open = datetime.time(8, 0)
        self.amenity.monday_close = datetime.time(17, 0)
        self.amenity.save()

        dt_monday = datetime.datetime(2023, 1, 2, 12, 0)  # Jan 2, 2023 is Monday
        open_t, close_t = self.amenity.get_todays_hours(dt_monday)
        self.assertEqual(open_t, datetime.time(8, 0))
        self.assertEqual(close_t, datetime.time(17, 0))

    def test_amenity_is_open_now(self):
        self.assertFalse(self.amenity_inactive.is_open_now())

        self.amenity.is_open_24hrs = True
        self.amenity.save()
        self.assertTrue(self.amenity.is_open_now())

        self.amenity.is_open_24hrs = False
        self.amenity.monday_open = datetime.time(8, 0)
        self.amenity.monday_close = datetime.time(17, 0)
        self.amenity.tuesday_open = datetime.time(18, 0)
        self.amenity.tuesday_close = datetime.time(2, 0)  # overnight
        self.amenity.save()

        dt_monday_open = datetime.datetime(2023, 1, 2, 12, 0)
        dt_monday_closed = datetime.datetime(2023, 1, 2, 18, 0)
        self.assertTrue(self.amenity.is_open_now(dt_monday_open))
        self.assertFalse(self.amenity.is_open_now(dt_monday_closed))

        dt_tuesday_open = datetime.datetime(2023, 1, 3, 20, 0)
        dt_wed_early = datetime.datetime(2023, 1, 4, 1, 0)
        self.assertTrue(self.amenity.is_open_now(dt_tuesday_open))
        self.assertTrue(self.amenity.is_open_now(dt_wed_early))

        self.amenity.monday_open = None
        self.amenity.monday_close = None
        self.assertIsNone(self.amenity.is_open_now(dt_monday_open))

    def test_amenity_hours_display(self):
        self.amenity.is_open_24hrs = True
        self.amenity.save()
        display = self.amenity.hours_display()
        self.assertEqual(display["Monday"], "24 Hours")

    def test_amenity_reviews_methods(self):
        self.assertIsNone(self.amenity.get_average_rating())
        self.assertEqual(self.amenity.get_review_count(), 0)

    def test_review_str(self):
        review1 = Review.objects.create(
            amenity=self.amenity, user=self.user, rating=5, review_text="Nice"
        )
        self.assertEqual(
            str(review1), f"Review by {self.user.email} for Test Amenity - 5★"
        )

    def test_amenity_photo_str(self):
        photo = AmenityPhoto.objects.create(amenity=self.amenity, uploaded_by=self.user)
        self.assertEqual(str(photo), f"Photo for Test Amenity by {self.user.email}")

    def test_favorite_str(self):
        favorite = Favorite.objects.create(user=self.user, amenity=self.amenity)
        self.assertEqual(
            str(favorite),
            f"{self.user.email} favorited {self.amenity.name}",
        )
