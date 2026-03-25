from django.contrib import admin
from .models import AmenityType, Amenity, Review, AmenityPhoto, CustomUser, Chat, ChatParticipant, Message


@admin.register(CustomUser)
class CustomUserAdmin(admin.ModelAdmin):
    list_display = ["email", "username", "is_staff", "created_at"]
    list_filter = ["is_staff", "is_superuser", "created_at"]
    search_fields = ["email", "username"]
    readonly_fields = ("created_at", "updated_at")
    fieldsets = (
        ("Account", {"fields": ("email", "username", "password")}),
        ("Profile", {"fields": ("first_name", "last_name", "bio")}),
        (
            "Permissions",
            {
                "fields": (
                    "is_active",
                    "is_staff",
                    "is_superuser",
                    "groups",
                    "user_permissions",
                ),
                "classes": ("collapse",),
            },
        ),
        (
            "Metadata",
            {"fields": ("created_at", "updated_at"), "classes": ("collapse",)},
        ),
    )


@admin.register(AmenityType)
class AmenityTypeAdmin(admin.ModelAdmin):
    list_display = ["name", "color"]
    search_fields = ["name"]


@admin.register(Amenity)
class AmenityAdmin(admin.ModelAdmin):
    list_display = ["name", "amenity_type", "active", "location", "created_at"]
    list_filter = ["amenity_type", "active", "created_at"]
    search_fields = ["name", "address", "description", "external_id"]
    fieldsets = (
        ("Basic Info", {"fields": ("name", "amenity_type", "active")}),
        ("Location", {"fields": ("location", "address", "prop_name")}),
        (
            "Details",
            {
                "fields": (
                    "description",
                    "operator",
                    "hours_of_operation",
                    "accessibility",
                    "changing_stations",
                    "external_id",
                ),
                "classes": ("collapse",),
            },
        ),
    )
    readonly_fields = ("created_at", "updated_at", "external_id")


@admin.register(Review)
class ReviewAdmin(admin.ModelAdmin):
    list_display = ["user", "amenity", "rating", "created_at"]
    list_filter = ["rating", "amenity", "created_at"]
    search_fields = ["user__email", "amenity__name", "review_text"]
    readonly_fields = ("created_at", "updated_at")
    fieldsets = (
        ("Review Info", {"fields": ("amenity", "user", "rating")}),
        ("Content", {"fields": ("review_text",)}),
        (
            "Metadata",
            {"fields": ("created_at", "updated_at"), "classes": ("collapse",)},
        ),
    )


@admin.register(AmenityPhoto)
class AmenityPhotoAdmin(admin.ModelAdmin):
    list_display = ["amenity", "uploaded_by", "is_primary", "created_at"]
    list_filter = ["amenity", "is_primary", "created_at"]
    search_fields = ["amenity__name", "uploaded_by__email", "caption"]
    readonly_fields = ("created_at",)
    fieldsets = (
        ("Photo Info", {"fields": ("amenity", "photo", "is_primary")}),
        ("Caption & Attribution", {"fields": ("caption", "uploaded_by")}),
        ("Metadata", {"fields": ("created_at",), "classes": ("collapse",)}),
    )


@admin.register(Chat)
class ChatAdmin(admin.ModelAdmin):
    list_display = ["id", "chat_type", "created_by", "amenity", "created_at", "last_message_at"]
    list_filter = ["chat_type", "created_at", "last_message_at"]
    search_fields = ["name", "created_by__email", "amenity__name"]
    readonly_fields = ("created_at", "updated_at")
    fieldsets = (
        ("Chat Info", {"fields": ("chat_type", "name", "amenity")}),
        ("Participants", {"fields": ("created_by",)}),
        ("Metadata", {"fields": ("created_at", "updated_at", "last_message_at"), "classes": ("collapse",)}),
    )


@admin.register(ChatParticipant)
class ChatParticipantAdmin(admin.ModelAdmin):
    list_display = ["user", "chat", "joined_at"]
    list_filter = ["chat", "joined_at"]
    search_fields = ["user__email", "chat__name"]
    readonly_fields = ("joined_at",)


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ["id", "chat", "sender", "created_at"]
    list_filter = ["chat", "sender", "created_at"]
    search_fields = ["sender__email", "chat__name", "content"]
    readonly_fields = ("created_at", "updated_at")
