
// create the map and set default view
const map = L.map('map').setView([40.7580, -73.9855], 13)

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

fetch('/api/amenities/')
    .then((response) => {
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
    })
    .then((data) => {
        const amenities = data.amenities || [];

        amenities.forEach((amenity) => {
            const marker = L.marker([amenity.latitude, amenity.longitude]).addTo(map);
            marker.bindPopup(amenity.name);
        });

        if (amenities.length > 0) {
            map.setView([amenities[0].latitude, amenities[0].longitude], 13);
        }
    })
    
    .catch((error) => {
        console.error('Failed to load amenities:', error);
    });
        
