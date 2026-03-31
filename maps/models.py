from django.contrib.gis.db import models
from django.contrib.postgres.indexes import GistIndex
from django.contrib.auth.models import AbstractUser
from django.templatetags.static import static
import datetime


class CustomUser(AbstractUser):
    """Custom user model with email as unique identifier."""

    email = models.EmailField(unique=True)
    bio = models.TextField(blank=True)
    avatar = models.ImageField(upload_to="avatars/%Y/%m/%d/", blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["username"]

    class Meta:
        ordering = ["-created_at"]

    @property
    def avatar_url(self):
        if self.avatar:
            if hasattr(self.avatar, "storage") and not self.avatar.storage.exists(
                self.avatar.name
            ):
                return static("maps/default-avatar.svg")
            return self.avatar.url
        return static("maps/default-avatar.svg")

    def __str__(self):
        return self.email


class AmenityType(models.Model):
    name = models.CharField(max_length=100, unique=True)
    icon = models.CharField(max_length=50, blank=True)
    color = models.CharField(max_length=7, default="#3388ff")
    parent = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="sub_types",
    )

    class Meta:
        verbose_name_plural = "Amenity Types"
        ordering = ["name"]

    def __str__(self):
        return f"{self.parent.name} -> {self.name}" if self.parent else self.name


class Amenity(models.Model):
    """Model to store amenity locations."""

    ACCESSIBILITY_CHOICES = [
        ("", "Unknown"),
        ("Not Accessible", "Not Accessible"),
        ("Limited Accessibility", "Limited Accessibility"),
        ("Partially Accessible", "Partially Accessible"),
        ("Fully Accessible", "Fully Accessible"),
    ]

    # Core fields
    amenity_type = models.ForeignKey(
        AmenityType, on_delete=models.CASCADE, related_name="amenities"
    )
    name = models.CharField(max_length=200)
    location = models.PointField(srid=4326, null=False)
    address = models.CharField(max_length=300, blank=True, null=True)
    prop_name = models.CharField(max_length=200, blank=True)
    description = models.TextField(blank=True)
    operator = models.CharField(max_length=200, blank=True)

    # Hours: raw parsed JSON
    # Stores the full parse_hours() output for display / notes / dusk values.
    hours_of_operation = models.JSONField(default=dict, blank=True)

    # Hours: structured per-day fields (for filtering)
    # Null = day not specified (or unknown).
    # Convention for 24-hour days: monday_open = 00:00, monday_close = 00:00
    is_open_24hrs = models.BooleanField(default=False)

    monday_open = models.TimeField(null=True, blank=True)
    monday_close = models.TimeField(null=True, blank=True)
    tuesday_open = models.TimeField(null=True, blank=True)
    tuesday_close = models.TimeField(null=True, blank=True)
    wednesday_open = models.TimeField(null=True, blank=True)
    wednesday_close = models.TimeField(null=True, blank=True)
    thursday_open = models.TimeField(null=True, blank=True)
    thursday_close = models.TimeField(null=True, blank=True)
    friday_open = models.TimeField(null=True, blank=True)
    friday_close = models.TimeField(null=True, blank=True)
    saturday_open = models.TimeField(null=True, blank=True)
    saturday_close = models.TimeField(null=True, blank=True)
    sunday_open = models.TimeField(null=True, blank=True)
    sunday_close = models.TimeField(null=True, blank=True)

    # Facility attributes
    changing_stations = models.BooleanField(default=False)
    accessibility = models.CharField(
        max_length=50, blank=True, choices=ACCESSIBILITY_CHOICES, default=""
    )
    active = models.BooleanField(default=True)
    seasonal = models.BooleanField(default=False)
    external_id = models.CharField(max_length=100, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        unique_together = [("amenity_type", "external_id")]
        indexes = [
            GistIndex(fields=["location"], name="amenity_location_gist_idx"),
            models.Index(fields=["active"]),
            models.Index(fields=["amenity_type", "active"]),
            models.Index(fields=["is_open_24hrs"]),
            models.Index(fields=["monday_open", "monday_close"]),
            models.Index(fields=["tuesday_open", "tuesday_close"]),
            models.Index(fields=["wednesday_open", "wednesday_close"]),
            models.Index(fields=["thursday_open", "thursday_close"]),
            models.Index(fields=["friday_open", "friday_close"]),
            models.Index(fields=["saturday_open", "saturday_close"]),
            models.Index(fields=["sunday_open", "sunday_close"]),
        ]

    def __str__(self):
        status = " (Inactive)" if not self.active else ""
        return f"{self.name} ({self.amenity_type.name}){status}"

    # Hours helpers

    DAY_FIELD_MAP = {
        0: ("monday_open", "monday_close"),
        1: ("tuesday_open", "tuesday_close"),
        2: ("wednesday_open", "wednesday_close"),
        3: ("thursday_open", "thursday_close"),
        4: ("friday_open", "friday_close"),
        5: ("saturday_open", "saturday_close"),
        6: ("sunday_open", "sunday_close"),
    }

    def get_todays_hours(self, now: datetime.datetime = None):
        """
        Returns (open_time, close_time) for today, or (None, None) if unknown/closed.
        Pass a datetime for testing; defaults to current local time.
        """
        if self.is_open_24hrs:
            return (datetime.time(0, 0), datetime.time(0, 0))
        now = now or datetime.datetime.now()
        open_field, close_field = self.DAY_FIELD_MAP[now.weekday()]
        return (getattr(self, open_field), getattr(self, close_field))

    def is_open_now(self, now: datetime.datetime = None) -> bool | None:
        """
        Returns True if currently open, False if currently closed, None if unknown.
        Handles overnight hours (e.g. 18:00 - 02:00).
        """
        if not self.active:
            return False
        if self.is_open_24hrs:
            return True

        now = now or datetime.datetime.now()
        open_t, close_t = self.get_todays_hours(now)

        if open_t is None or close_t is None:
            yesterday_idx = (now.weekday() - 1) % 7
            y_open_field, y_close_field = self.DAY_FIELD_MAP[yesterday_idx]
            y_open = getattr(self, y_open_field)
            y_close = getattr(self, y_close_field)
            if y_open and y_close and y_close < y_open:
                if now.time() < y_close:
                    return True
            return None

        current = now.time()

        if close_t <= open_t:
            return current >= open_t or current < close_t
        else:
            return open_t <= current < close_t

    def hours_display(self) -> dict:
        """
        Returns a human-friendly dict of
        {day_name: 'HH:MM - HH:MM' or 'Closed' or 'Unknown'}.
        Useful for templates.
        """
        result = {}
        day_names = [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
        ]
        for idx, (open_field, close_field) in self.DAY_FIELD_MAP.items():
            day_name = day_names[idx]
            o = getattr(self, open_field)
            c = getattr(self, close_field)
            if self.is_open_24hrs:
                result[day_name] = "24 Hours"
            elif o and c:
                result[day_name] = (
                    f'{o.strftime("%I:%M %p").lstrip("0")} '
                    f'- {c.strftime("%I:%M %p").lstrip("0")}'
                )
            else:
                result[day_name] = "Unknown"
        return result

    # Review helpers

    def get_average_rating(self):
        reviews = self.reviews.all()
        if not reviews.exists():
            return None
        from django.db.models import Avg

        return reviews.aggregate(Avg("rating"))["rating__avg"]

    def get_review_count(self):
        return self.reviews.count()


class Review(models.Model):
    """User review for an amenity."""

    amenity = models.ForeignKey(
        Amenity, on_delete=models.CASCADE, related_name="reviews"
    )
    user = models.ForeignKey(
        CustomUser,
        on_delete=models.CASCADE,
        related_name="reviews",
        null=True,
        blank=True,
    )
    rating = models.IntegerField(
        choices=[(i, f'{i} Star{"s" if i != 1 else ""}') for i in range(1, 6)],
        help_text="Rating from 1 to 5 stars",
    )
    review_text = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        unique_together = [("amenity", "user")]
        indexes = [
            models.Index(fields=["amenity", "-created_at"]),
            models.Index(fields=["user", "-created_at"]),
        ]

    def __str__(self):
        user_name = self.user.email if self.user else "Anonymous"
        return f"Review by {user_name} for {self.amenity.name} - {self.rating}★"


class ReviewVote(models.Model):
    """Per-user up/down vote for a review."""

    VOTE_CHOICES = [
        (1, "Upvote"),
        (-1, "Downvote"),
    ]

    review = models.ForeignKey(Review, on_delete=models.CASCADE, related_name="votes")
    user = models.ForeignKey(
        CustomUser,
        on_delete=models.CASCADE,
        related_name="review_votes",
    )
    value = models.SmallIntegerField(choices=VOTE_CHOICES)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("review", "user")]
        indexes = [
            models.Index(fields=["review", "value"], name="review_vote_score_idx"),
            models.Index(
                fields=["user", "-updated_at"],
                name="review_vote_user_updated_idx",
            ),
        ]

    def __str__(self):
        vote_label = "upvote" if self.value == 1 else "downvote"
        return f"{self.user.email} {vote_label}d review {self.review_id}"


class Favorite(models.Model):
    """Per-user favorite amenity."""

    user = models.ForeignKey(
        CustomUser,
        on_delete=models.CASCADE,
        related_name="favorites",
    )
    amenity = models.ForeignKey(
        Amenity,
        on_delete=models.CASCADE,
        related_name="favorited_by",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        unique_together = [("user", "amenity")]
        indexes = [
            models.Index(fields=["user", "-created_at"], name="fav_user_created_idx"),
            models.Index(fields=["amenity", "user"], name="fav_amenity_user_idx"),
        ]

    def __str__(self):
        return f"{self.user.email} favorited {self.amenity.name}"


class AmenityPhoto(models.Model):
    """Photos for amenities uploaded by users."""

    amenity = models.ForeignKey(
        Amenity, on_delete=models.CASCADE, related_name="photos"
    )
    photo = models.ImageField(upload_to="amenity_photos/%Y/%m/%d/")
    caption = models.CharField(max_length=300, blank=True)
    uploaded_by = models.ForeignKey(
        CustomUser, on_delete=models.CASCADE, related_name="amenity_photos"
    )
    is_primary = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-is_primary", "-created_at"]
        indexes = [
            models.Index(fields=["amenity", "-is_primary"]),
        ]

    def __str__(self):
        return f"Photo for {self.amenity.name} by {self.uploaded_by.email}"


class Chat(models.Model):
    """Model for individual and group chats."""

    CHAT_TYPE_CHOICES = [
        ("direct", "Direct Message"),
        ("group", "Group Chat"),
        ("amenity_forum", "Amenity Forum"),
    ]

    chat_type = models.CharField(
        max_length=20, choices=CHAT_TYPE_CHOICES, default="direct"
    )
    amenity = models.ForeignKey(
        Amenity,
        on_delete=models.CASCADE,
        related_name="chats",
        null=True,
        blank=True,
        help_text="For amenity forum chats, reference the amenity being discussed",
    )
    created_by = models.ForeignKey(
        CustomUser, on_delete=models.CASCADE, related_name="created_chats"
    )
    name = models.CharField(
        max_length=200, blank=True, help_text="Custom name for group and forum chats"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    last_message_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-last_message_at"]
        indexes = [
            models.Index(fields=["-last_message_at"]),
            models.Index(fields=["chat_type", "-last_message_at"]),
        ]

    def __str__(self):
        if self.name:
            return self.name
        if self.chat_type == "amenity_forum" and self.amenity:
            return f"Forum: {self.amenity.name}"
        return f"Chat {self.id}"

    def get_display_name(self, current_user):
        """Get the display name for this chat from the perspective of a user."""
        if self.name:
            return self.name
        if self.chat_type == "direct":
            # For direct chats, show the other person's email
            other_user = self.participants.exclude(user=current_user).first()
            return other_user.user.email if other_user else "Unknown"
        if self.chat_type == "amenity_forum" and self.amenity:
            return f"Forum: {self.amenity.name}"
        return "Chat"


class ChatParticipant(models.Model):
    """Model to track participants in a chat."""

    chat = models.ForeignKey(
        Chat, on_delete=models.CASCADE, related_name="participants"
    )
    user = models.ForeignKey(
        CustomUser, on_delete=models.CASCADE, related_name="chat_participations"
    )
    joined_at = models.DateTimeField(auto_now_add=True)
    last_read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = [("chat", "user")]
        ordering = ["joined_at"]
        indexes = [
            models.Index(fields=["user", "-joined_at"]),
        ]

    def __str__(self):
        return f"{self.user.email} in {self.chat}"


class Message(models.Model):
    """Model for individual messages in a chat."""

    chat = models.ForeignKey(Chat, on_delete=models.CASCADE, related_name="messages")
    sender = models.ForeignKey(
        CustomUser, on_delete=models.CASCADE, related_name="sent_messages"
    )
    content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["chat", "-created_at"]),
            models.Index(fields=["sender", "-created_at"]),
        ]

    def __str__(self):
        return f"Message from {self.sender.email} in {self.chat}"
