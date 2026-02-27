from django.urls import path
from .import views

urlpatterns = [
    path('', views.map_view, name = 'map'),
    path('api/amenities/', views.amenities_api, name='amenities_api')
]