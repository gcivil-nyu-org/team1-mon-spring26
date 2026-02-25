from django.db import models


class AmenityType(models.Model):
    name = models.CharField(max_length=100, unique=True)
    icon = models.CharField(max_length=50, blank=True)
    color = models.CharField(max_length=7, default='#3388ff')

    def __str__(self):
        return self.name


class Amenity(models.Model):
    amenity_type = models.ForeignKey(AmenityType, on_delete=models.CASCADE, related_name='amenities')
    name = models.CharField(max_length=200)
    latitude = models.DecimalField(max_digits=9, decimal_places=6)
    longitude = models.DecimalField(max_digits=9, decimal_places=6)
    position = models.CharField(max_length=500, blank=True)
    prop_name = models.CharField(max_length=200, blank=True)
    description = models.TextField(blank=True)
    operator = models.CharField(max_length=200, blank=True)
    hours_of_operation = models.TextField(blank=True)
    changing_stations = models.BooleanField(default=False)
    accessibility = models.CharField(max_length=50, blank=True, default='')
    active = models.BooleanField(default=True)
    external_id = models.CharField(max_length=100, blank=True)

    class Meta:
        unique_together = [('amenity_type', 'external_id')]

    def __str__(self):
        return f"{self.name} ({self.amenity_type.name})"