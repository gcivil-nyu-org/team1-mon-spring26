from django.urls import path
from . import views

app_name = 'maps'

urlpatterns = [
    path('', views.map_view, name='map'),
    path('api/amenities/', views.amenities_api, name='amenities_api'),
    path('api/amenity-types/', views.amenity_types_api, name='amenity_types_api'),
    path('api/auth/register/', views.register_api, name='register_api'),
    path('api/auth/login/', views.login_api, name='login_api'),
    path('api/reviews/', views.create_review_api, name='create_review_api'),
]
