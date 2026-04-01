from django.urls import path
from . import views

app_name = "maps"

urlpatterns = [
    path("", views.map_view, name="map"),
    path("profile/", views.profile_view, name="profile"),
    path("settings/", views.settings_view, name="settings"),
    path("api/profile/", views.update_profile_api, name="update_profile_api"),
    path(
        "api/account/password/", views.change_password_api, name="change_password_api"
    ),
    path("api/profile/reviews/", views.profile_reviews_api, name="profile_reviews_api"),
    path(
        "api/profile/favorites/",
        views.profile_favorites_api,
        name="profile_favorites_api",
    ),
    path("chats/", views.chats_view, name="chats"),
    path("api/amenities/", views.amenities_api, name="amenities_api"),
    path(
        "api/amenities/<int:amenity_id>/",
        views.amenity_detail_api,
        name="amenity_detail_api",
    ),
    path(
        "api/amenities/<int:amenity_id>/favorite/",
        views.toggle_favorite_api,
        name="toggle_favorite_api",
    ),
    path(
        "api/amenities/<int:amenity_id>/rating-distribution/",
        views.amenity_rating_distribution_api,
        name="amenity_rating_distribution_api",
    ),
    path("api/amenity-types/", views.amenity_types_api, name="amenity_types_api"),
    path("api/auth/register/", views.register_api, name="register_api"),
    path("api/auth/login/", views.login_api, name="login_api"),
    path("api/auth/logout/", views.logout_api, name="logout_api"),
    path("api/auth/me/", views.current_user_api, name="current_user_api"),
    path("api/reviews/", views.create_review_api, name="create_review_api"),
    path(
        "api/reviews/<int:review_id>/",
        views.review_detail_api,
        name="review_detail_api",
    ),
    path(
        "api/reviews/<int:review_id>/vote/",
        views.review_vote_api,
        name="review_vote_api",
    ),
    path(
        "api/reviews/list/",
        views.get_amenity_reviews_api,
        name="get_amenity_reviews_api",
    ),
    # Chat endpoints
    path("api/chats/", views.get_user_chats_api, name="get_user_chats_api"),
    path(
        "api/chats/messages/", views.get_chat_messages_api, name="get_chat_messages_api"
    ),
    path("api/chats/send/", views.send_message_api, name="send_message_api"),
    path(
        "api/chats/direct/", views.create_direct_chat_api, name="create_direct_chat_api"
    ),
    path("api/chats/group/", views.create_group_chat_api, name="create_group_chat_api"),
    path("api/amenities/search/", views.amenity_search_api, name="amenity_search_api"),
    path(
        "api/amenities/reviewers/",
        views.get_amenity_reviewers_api,
        name="get_amenity_reviewers_api",
    ),
]
