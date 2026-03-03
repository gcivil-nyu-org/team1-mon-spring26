#from django.db import models
from django.contrib.gis.db import models
from django.contrib.postgres.indexes import GistIndex
from django.contrib.auth.models import AbstractUser
import re


class CustomUser(AbstractUser):
    """Custom user model with email as unique identifier"""
    email = models.EmailField(unique=True)
    bio = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = ['username']  # Required for createsuperuser
    
    class Meta:
        ordering = ['-created_at']
    
    def __str__(self):
        return self.email


class AmenityType(models.Model):
    """Model to store different types of amenities (e.g., water fountains, restrooms)."""
    name = models.CharField(max_length=100, unique=True)
    icon = models.CharField(max_length=50, blank=True)  # For storing icon identifiers
    color = models.CharField(max_length=7, default='#3388ff')  # Hex color for map markers
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='sub_types')
    
    class Meta:
        verbose_name_plural = "Amenity Types"
        ordering = ['name']
    
    def __str__(self):
        return f"{self.parent.name} -> {self.name}" if self.parent else self.name


class Amenity(models.Model):
    """Model to store amenity locations."""
    amenity_type = models.ForeignKey(AmenityType, on_delete=models.CASCADE, related_name='amenities')
    name = models.CharField(max_length=200)
    location = models.PointField(srid=4326, null=False)
    address = models.CharField(max_length=300, blank=True, null=True)
    #position = models.CharField(max_length=500, blank=True)  # Text description for location
    prop_name = models.CharField(max_length=200, blank=True)  # Property name (e.g., park name)
    description = models.TextField(blank=True)
    operator = models.CharField(max_length=200, blank=True)  # Owner/operator (e.g., parks dept, business)
    hours_of_operation = models.JSONField(default=dict, blank=True) # Structured hours (e.g., {"Monday": "10am-6pm"})
    changing_stations = models.BooleanField(default=False)  # Whether facility has changing stations
    accessibility = models.CharField(
        max_length=50,
        blank=True,
        choices=[
            ('', 'Unknown'),
            ('Not Accessible', 'Not Accessible'),
            ('Partially Accessible', 'Partially Accessible'),
            ('Fully Accessible', 'Fully Accessible'),
        ],
        default=''
    )  # ADA accessibility status
    active = models.BooleanField(default=True)  # Whether the amenity is operational
    seasonal = models.BooleanField(default=False) # Whether the amenity is seasonal
    external_id = models.CharField(max_length=100, blank=True)  # For referencing external datasets (keyed by amenity_type)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        ordering = ['-created_at']
        unique_together = [('amenity_type', 'external_id')]
        indexes = [
            GistIndex(fields=['location'], name='amenity_location_gist_idx'),
            models.Index(fields=['active']),
            models.Index(fields=['amenity_type', 'active']),
        ]
    
    def __str__(self):
        status = " (Inactive)" if not self.active else ""
        return f"{self.name} ({self.amenity_type.name}){status}"
    
    def get_average_rating(self):
        """Calculate average rating from all reviews"""
        reviews = self.reviews.all()
        if not reviews.exists():
            return None
        from django.db.models import Avg
        return reviews.aggregate(Avg('rating'))['rating__avg']
    
    def get_review_count(self):
        """Get total number of reviews"""
        return self.reviews.count()


class Review(models.Model):
    """User review for an amenity"""
    amenity = models.ForeignKey(Amenity, on_delete=models.CASCADE, related_name='reviews')
    user = models.ForeignKey(CustomUser, on_delete=models.CASCADE, related_name='reviews', null=True, blank=True)
    rating = models.IntegerField(
        choices=[(i, f'{i} Star{"s" if i != 1 else ""}') for i in range(1, 6)],
        help_text="Rating from 1 to 5 stars"
    )
    review_text = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        ordering = ['-created_at']
        unique_together = [('amenity', 'user')]  # One review per user per amenity
        indexes = [
            models.Index(fields=['amenity', '-created_at']),
            models.Index(fields=['user', '-created_at']),
        ]
    
    def __str__(self):
        user_name = self.user.email if self.user else "Anonymous"
        return f"Review by {user_name} for {self.amenity.name} - {self.rating}★"


class AmenityPhoto(models.Model):
    """Photos for amenities uploaded by users"""
    amenity = models.ForeignKey(Amenity, on_delete=models.CASCADE, related_name='photos')
    photo = models.ImageField(upload_to='amenity_photos/%Y/%m/%d/')
    caption = models.CharField(max_length=300, blank=True)
    uploaded_by = models.ForeignKey(CustomUser, on_delete=models.CASCADE, related_name='amenity_photos')
    is_primary = models.BooleanField(default=False)  # Mark one photo as the primary/featured photo
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        ordering = ['-is_primary', '-created_at']
        indexes = [
            models.Index(fields=['amenity', '-is_primary']),
        ]
    
    def __str__(self):
        return f"Photo for {self.amenity.name} by {self.uploaded_by.email}"
