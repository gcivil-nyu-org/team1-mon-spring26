// Initialize map with default center
const map = L.map('map', { renderer: L.canvas() }).setView([40, -95], 4);

// Add OpenStreetMap tile layer
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// State management
let userLocation = null;
let userMarker = null;
let selectedLocationMarker = null;

// Layer groups for markers. We will manage them manually now.
let bikeRackMarkers = L.layerGroup();
let otherAmenityMarkers = L.layerGroup(); // For non-clustered amenities

let activeAmenityTypes = new Set();
let allAmenitiesData = {};
let searchTimeout = null;
let searchAbortController = null;
let currentDetailAmenity = null;
let currentUser = null;

/**
 * Request user's geolocation and move map to their location
 */
function initializeGeolocation() {
    const statusEl = document.getElementById('location-status');
    const locationBtn = document.getElementById('location-button');
    
    if (!navigator.geolocation) {
        statusEl.textContent = 'Geolocation not supported';
        statusEl.style.color = '#f44336';
        return;
    }
    
    // Add visual feedback
    locationBtn.classList.add('locating');
    statusEl.textContent = 'Locating...';
    statusEl.style.color = '#999';
    
    // Set a fallback timeout in case geolocation takes too long
    const timeoutId = setTimeout(() => {
        if (!userLocation) {
            statusEl.textContent = 'Using default location';
            statusEl.style.color = '#FF9800';
            locationBtn.classList.remove('locating');
            // Use default center - USA center
            map.setView([39.8283, -98.5795], 4);
        }
    }, 8000);
    
    navigator.geolocation.getCurrentPosition(
        (position) => {
            clearTimeout(timeoutId);
            const { latitude, longitude } = position.coords;
            userLocation = { latitude, longitude };
            
            // Move map to user location
            map.setView([latitude, longitude], 15);
            
            // Add marker at user location
            if (userMarker) {
                map.removeLayer(userMarker);
            }
            userMarker = L.marker([latitude, longitude], {
                title: 'Your Location',
                zIndexOffset: 100
            }).addTo(map);
            
            userMarker.bindPopup('Your Location');
            
            statusEl.textContent = 'Location found ✓';
            statusEl.style.color = '#4CAF50';
            locationBtn.classList.remove('locating');
        },
        (error) => {
            clearTimeout(timeoutId);
            locationBtn.classList.remove('locating');
            
            console.error('Geolocation error:', error);
            
            if (error.code === error.PERMISSION_DENIED) {
                statusEl.textContent = 'Location permission denied';
            } else if (error.code === error.POSITION_UNAVAILABLE) {
                statusEl.textContent = 'Location unavailable';
            } else if (error.code === error.TIMEOUT) {
                statusEl.textContent = 'Location request timed out';
            } else {
                statusEl.textContent = 'Unable to get location';
            }
            
            statusEl.style.color = '#f44336';
            
            // Set default location
            map.setView([39.8283, -98.5795], 4);
        },
        {
            enableHighAccuracy: true,
            timeout: 7000,
            maximumAge: 0
        }
    );
}

/**
 * Retry geolocation when user clicks the location button
 */
function retryGeolocation() {
    userLocation = null;
    if (userMarker) {
        map.removeLayer(userMarker);
        userMarker = null;
    }
    initializeGeolocation();
}

/**
 * Fetch all amenity types and populate the sidebar
 */
function loadAmenityTypes() {
    // Load saved amenity types from localStorage
    const savedAmenityTypes = localStorage.getItem('activeAmenityTypes');
    const previouslyActiveTypes = savedAmenityTypes ? new Set(JSON.parse(savedAmenityTypes).map(id => String(id))) : null;

    fetch('/api/amenity-types/')
        .then(response => response.json())
        .then(data => {
            if (data.types.length === 0) {
                document.getElementById('amenity-list').innerHTML = 
                    '<p style="color: #999; font-size: 14px;">No amenity types yet</p>';
                return;
            }
            
            const amenityList = document.getElementById('amenity-list');
            amenityList.innerHTML = '';
            
            // Function to create a single amenity item (checkbox)
            const createAmenityItem = (type, isSubItem = false) => {
                const item = document.createElement('div');
                item.className = 'amenity-item';
                if (isSubItem) {
                    item.classList.add('sub-item');
                }
                item.dataset.typeId = type.id;

                let isChecked;
                if (previouslyActiveTypes) {
                    // If there's a saved state, use it
                    isChecked = previouslyActiveTypes.has(String(type.id));
                } else {
                    // Otherwise, use the default logic
                    isChecked = type.name === 'Water Fountain' || type.name === 'Cooling Sites';
                }

                item.innerHTML = `
                    <input type="checkbox" class="amenity-checkbox" data-type-id="${type.id}" ${isChecked ? 'checked' : ''}>
                    <div class="amenity-color" style="background-color: ${type.color}"></div>
                    <span class="amenity-item-label">${type.name}</span>
                `;

                const checkbox = item.querySelector('.amenity-checkbox');

                if (checkbox.checked) {
                    activeAmenityTypes.add(type.id);
                    item.classList.add('active');
                }

                return { item, checkbox };
            };

            data.types.forEach(type => {
                const { item, checkbox } = createAmenityItem(type);
                amenityList.appendChild(item);

                // If it has sub-types, create a container for them
                if (type.sub_types && type.sub_types.length > 0) {
                    const subList = document.createElement('div');
                    subList.className = 'amenity-sub-list';
                    amenityList.appendChild(subList);

                    let anySubtypeChecked = false;

                    type.sub_types.forEach(subType => {
                        const { item: subItem, checkbox: subCheckbox } = createAmenityItem(subType, true);
                        if (subCheckbox.checked) {
                            anySubtypeChecked = true;
                        }
                        subList.appendChild(subItem);
                        subCheckbox.addEventListener('change', () => toggleAmenityType(subType.id, subItem, subCheckbox));
                    });

                    // Show sub-list if parent is checked or if any sub-item was checked from localStorage
                    if (checkbox.checked || anySubtypeChecked) {
                        subList.style.display = 'flex';
                    } else {
                        subList.style.display = 'none';
                    }
                }

                item.addEventListener('click', (e) => {
                    if (e.target !== checkbox) {
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event('change'));
                    }
                });

                checkbox.addEventListener('change', () => {
                    const subTypeIds = (type.sub_types || []).map(st => st.id);
                    toggleAmenityType(type.id, item, checkbox, subTypeIds);

                    // If it's a parent, toggle all its children
                    if (type.sub_types && type.sub_types.length > 0) {
                        const subList = item.nextElementSibling;
                        subList.style.display = checkbox.checked ? 'flex' : 'none';

                        const subCheckboxes = item.nextElementSibling.querySelectorAll('.amenity-checkbox');
                        subCheckboxes.forEach(subCheckbox => {
                            if (subCheckbox.checked !== checkbox.checked) {
                                subCheckbox.checked = checkbox.checked;
                                subCheckbox.dispatchEvent(new Event('change'));
                            }
                        });
                    }
                });
            });
        })
        .catch(error => console.error('Error loading amenity types:', error));
}

/**
 * Toggle amenity type selection and filter markers
 */
function toggleAmenityType(typeId, element, checkbox, subTypeIds = []) {
    if (checkbox.checked) {
        activeAmenityTypes.add(typeId);
        element.classList.add('active');
        // If it's a parent, also add all its children
        subTypeIds.forEach(id => activeAmenityTypes.add(id));

        // If we don't have data for this type, fetch it. Otherwise, just update the display.
        if (!allAmenitiesData[typeId]) {
            loadAmenities();
        } else {
            updateDisplayedAmenities();
        }
    } else {
        activeAmenityTypes.delete(typeId);
        element.classList.remove('active');
        // If it's a parent, also remove all its children
        subTypeIds.forEach(id => activeAmenityTypes.delete(id));
        // When unchecking, just update the display to hide markers. No need to fetch.
        updateDisplayedAmenities();
    }
    
    // Save the updated set of active types to localStorage
    localStorage.setItem('activeAmenityTypes', JSON.stringify(Array.from(activeAmenityTypes)));
}

/**
 * Fetch all amenities from the API within the current map bounds.
 * This function makes a single API call to get all visible amenities,
 * which are then filtered on the client-side by `updateDisplayedAmenities`.
 */
function loadAmenities() {
    // Clear the cache before every fetch to ensure we get fresh data (clusters or points)
    allAmenitiesData = {};

    // If no amenity types are selected, clear the map and don't fetch.
    if (activeAmenityTypes.size === 0) {
        allAmenitiesData = {};
        updateDisplayedAmenities();
        return;
    }

    const bounds = map.getBounds();
    const includeInactive = document.getElementById('include-inactive').checked;
    const onlyAccessible = document.getElementById('only-accessible').checked;
    
    const params = new URLSearchParams({
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
        zoom: map.getZoom(), // Send current zoom level to the backend
        include_inactive: includeInactive,
        only_accessible: onlyAccessible
    });

    // Add the active amenity types to the request
    activeAmenityTypes.forEach(typeId => {
        params.append('type_id', typeId);
    });
    
    fetch(`/api/amenities/?${params}`)
        .then(response => response.json())
        .then(data => {
            // Merge new data into our cache instead of replacing it
            data.amenities.forEach(amenity => {
                if (!allAmenitiesData[amenity.type_id]) {
                    allAmenitiesData[amenity.type_id] = [];
                }
                // A simple check to avoid duplicate entries if the API sends them
                if (!allAmenitiesData[amenity.type_id].some(a => a.id === amenity.id)) {
                    allAmenitiesData[amenity.type_id].push(amenity);
                }
            });
            
            updateDisplayedAmenities(); // This will now filter from the comprehensive `allAmenitiesData`
        })
        .catch(error => console.error('Error loading amenities:', error));
}

/**
 * Update displayed amenities on the map based on active filters
 */
function updateDisplayedAmenities() {
    // Clear all existing markers from the layer groups
    bikeRackMarkers.clearLayers();
    otherAmenityMarkers.clearLayers();

    // Don't show any amenities if no types are selected
    if (activeAmenityTypes.size === 0) {
        return; // Don't show any amenities if nothing is selected
    }
    
    // Show only amenities of selected types
    activeAmenityTypes.forEach(typeId => {
        if (allAmenitiesData[typeId]) {
            allAmenitiesData[typeId].forEach(amenity => addAmenityMarker(amenity));
        }
    });
}

/**
 * Add a single amenity marker to the map
 */
function addAmenityMarker(amenity) {
    // --- Handle backend-provided clusters ---
    if (amenity.is_cluster) {
        const count = amenity.point_count;
        const c = ' marker-cluster-';
        const className = 'marker-cluster' + (count < 10 ? c + 'small' : count < 100 ? c + 'medium' : c + 'large');
        
        // Create a cluster icon. Bike rack clusters are always orange.
        const clusterIcon = L.divIcon({
            html: `<div style="background-color: ${amenity.color};"><span>${count}</span></div>`,
            className: className,
            iconSize: L.point(40, 40)
        });

        const clusterMarker = L.marker([amenity.latitude, amenity.longitude], {
            icon: clusterIcon
        });

        // When a cluster is clicked, zoom in.
        clusterMarker.on('click', () => {
            // A simple way to zoom in is to increase the zoom level by 2.
            // A more advanced implementation could calculate the bounds of the cluster.
            const currentZoom = map.getZoom();
            map.flyTo([amenity.latitude, amenity.longitude], currentZoom + 2);
        });

        // Add the cluster marker to the bike rack layer.
        bikeRackMarkers.addLayer(clusterMarker);
        return; // Stop here for clusters
    }

    // --- Handle individual markers (non-clusters) ---
    // If we reach here, it's a regular amenity, not a cluster.
    // This logic is mostly the same as before.


    // Style inactive amenities with reduced opacity
    const opacity = amenity.active ? 1 : 0.5;
    const filter = amenity.active ? '' : 'opacity(0.5)';
    
    // Define SVG paths for different icons
    const icons = {
        'droplet': '<path d="M12 0 C8 8, 2 14, 2 19 C2 26.7, 6.5 32, 12 32 C17.5 32, 22 26.7, 22 19 C22 14, 16 8, 12 0 Z"/>',
        'restroom': '<path d="M4,8 C4,6.34 5.34,5 7,5 C8.66,5 10,6.34 10,8 C10,9.66 8.66,11 7,11 C5.34,11 4,9.66 4,8 M17,5 C15.34,5 14,6.34 14,8 C14,9.66 15.34,11 17,11 C18.66,11 20,9.66 20,8 C20,6.34 18.66,5 17,5 M12,13 L12,30 L16,30 L16,20 L18,20 L18,30 L22,30 L22,13 L12,13 M2,13 L2,30 L6,30 L6,20 L8,20 L8,30 L12,30 L12,13 L2,13 Z"/>',
        'bicycle': '<path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>',
        'snowflake': '<path d="M12 2.5l-2.5 4.33h5L12 2.5zm0 19l-2.5-4.33h5L12 21.5zM4.33 7.5L2.5 12l1.83 4.5h4.34L4.33 7.5zm15.34 0L15.33 12l1.83 4.5h4.34L19.67 7.5zM8.67 16.5L12 10l3.33 6.5H8.67zm0-9L12 14l3.33-6.5H8.67z" transform="scale(1.2) translate(-2, -2)"/>',
        'default': '<path d="M12 0 C8 8, 2 14, 2 19 C2 26.7, 6.5 32, 12 32 C17.5 32, 22 26.7, 22 19 C22 14, 16 8, 12 0 Z"/>'
    };

    const iconPath = icons[amenity.icon] || icons['default'];

    // Create water drop icon using divIcon with HTML
    const icon = L.divIcon({
        html: `
            <div style="
                width: 24px;
                height: 32px;
                position: relative;
                filter: ${filter};"
                class="amenity-marker-icon"
            ">
                <svg viewBox="0 0 24 32" width="24" height="32" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                        <style>
                            .amenity-icon-path-${amenity.id} { 
                                fill: ${amenity.color};
                                stroke: ${amenity.active ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.2)'};
                                stroke-width: 0.5;
                                transform-origin: center;
                            }
                        </style>
                    </defs>
                    <g class="amenity-icon-path-${amenity.id}">
                        ${iconPath}
                    </g>
                </svg>
            </div>
        `,
        iconSize: [24, 32],
        iconAnchor: [12, 32],
        popupAnchor: [0, -32],
        className: 'leaflet-div-icon-custom' // Use a generic class to avoid confusion
    });
    
    const marker = L.marker([amenity.latitude, amenity.longitude], { icon: icon, amenityData: amenity });
    
    // Add click handler to show detail panel
    marker.on('click', () => {
        showDetailPanel(amenity);
    });
    
    const statusText = amenity.active ? '' : ' (Inactive)';
    
    // Create popup HTML with navigation buttons
    const walkingUrl = `https://www.google.com/maps/dir/?api=1&destination=${amenity.latitude},${amenity.longitude}&travelmode=walking`;
    const cyclingUrl = `https://www.google.com/maps/dir/?api=1&destination=${amenity.latitude},${amenity.longitude}&travelmode=bicycling`;
    
    // Build rating stars display
    let ratingDisplay = '';
    if (amenity.rating) {
        const stars = Math.round(amenity.rating);
        const filledStars = '★'.repeat(stars);
        const emptyStars = '☆'.repeat(5 - stars);
        ratingDisplay = `
            <div class="amenity-popup-section">
                <div style="font-size: 14px; color: #FFC107;">${filledStars}${emptyStars}</div>
                <small style="color: #666;">${amenity.rating} (${amenity.review_count} reviews)</small>
            </div>
        `;
    }
    
    // Build photo display
    let photoDisplay = '';
    if (amenity.photo_url) {
        photoDisplay = `
            <img src="${amenity.photo_url}" alt="${amenity.prop_name || amenity.name}" 
                 style="width: 100%; height: auto; max-height: 150px; object-fit: cover; border-radius: 4px; margin-bottom: 12px;">
        `;
    }
    
    // Build reviews display
    let reviewsDisplay = '';
    if (amenity.reviews && amenity.reviews.length > 0) {
        const reviewsHtml = amenity.reviews.map(review => `
            <div style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <strong style="font-size: 12px; color: #333;">${review.user_name}</strong>
                    <span style="color: #FFC107;">${'★'.repeat(review.rating)}${'☆'.repeat(5-review.rating)}</span>
                </div>
                <div style="font-size: 11px; color: #666; line-height: 1.3;">${review.review_text}</div>
            </div>
        `).join('');
        
        reviewsDisplay = `
            <div class="amenity-popup-section">
                <div class="amenity-popup-label">Reviews (${amenity.review_count})</div>
                <div class="amenity-popup-value" style="font-size: 12px; max-height: 100px; overflow-y: auto; border-left: 3px solid #2196F3; padding-left: 8px;">
                    ${reviewsHtml}
                </div>
            </div>
        `;
    }
    
    // Define emojis for popup titles
    const popupIcons = {
        'droplet': '💧',
        'restroom': '🚻',
        'bicycle': '🚲',
        'snowflake': '❄️',
        'default': '📍' // A generic location pin
    };
    const popupIcon = popupIcons[amenity.icon] || popupIcons['default'];
    
    const popupContent = `
        <div class="amenity-popup">
            <div class="amenity-popup-header">
                ${photoDisplay}
                <h3>${popupIcon} ${amenity.prop_name || amenity.name}</h3>
                ${statusText ? `<small style="color: #f44336;">${statusText}</small>` : ''}
            </div>
            <div class="amenity-popup-body">
                ${ratingDisplay}
                ${amenity.position ? `
                <div class="amenity-popup-section">
                    <div class="amenity-popup-label">Position</div>
                    <div class="amenity-popup-value">${amenity.position}</div>
                </div>
                ` : ''}
                ${amenity.address ? `
                <div class="amenity-popup-section">
                    <div class="amenity-popup-label">Address</div>
                    <div class="amenity-popup-value">${amenity.address}</div>
                </div>
                ` : ''}
                ${amenity.description ? `
                <div class="amenity-popup-section">
                    <div class="amenity-popup-label">Description</div>
                    <div class="amenity-popup-value" style="font-size: 12px;">${amenity.description}</div>
                </div>
                ` : ''}
                ${reviewsDisplay}
                <div class="amenity-popup-navigation">
                    <a href="${walkingUrl}" target="_blank" class="amenity-nav-button">🚶 Walk</a>
                    <a href="${cyclingUrl}" target="_blank" class="amenity-nav-button">🚴 Bike</a>
                </div>
            </div>
        </div>
    `;
    
    marker.bindPopup(popupContent);
    // Add the marker to the appropriate group based on its type
    if (amenity.type === 'Bike Rack' || amenity.type.includes('Bike Rack')) {
        bikeRackMarkers.addLayer(marker);
    } else {
        otherAmenityMarkers.addLayer(marker);
    }
}

/**
 * Show detail panel for a selected amenity
 */
function showDetailPanel(amenity) {
    currentDetailAmenity = amenity;
    
    const panel = document.getElementById('detail-panel');
    const nameEl = document.getElementById('detail-name');
    const contentEl = document.getElementById('detail-content');
    
    // Set name and status
    nameEl.textContent = amenity.name;
    
    // Build content
    const statusBadge = amenity.active 
        ? '<span class="detail-status active">ACTIVE</span>'
        : '<span class="detail-status inactive">INACTIVE</span>';
    
    let content = `
        <div class="detail-field">
            ${statusBadge}
        </div>
        
        <div class="detail-field">
            <div class="detail-field-label">Type</div>
            <div class="detail-field-value">${amenity.type}</div>
        </div>
    `;
    
    if (amenity.prop_name) {
        content += `
        <div class="detail-field">
            <div class="detail-field-label">Location</div>
            <div class="detail-field-value">${amenity.prop_name}</div>
        </div>
        `;
    }
    
    if (amenity.position) {
        content += `
        <div class="detail-field">
            <div class="detail-field-label">Position</div>
            <div class="detail-field-value">${amenity.position}</div>
        </div>
        `;
    }
    
    if (amenity.address) {
        content += `
        <div class="detail-field">
            <div class="detail-field-label">Address</div>
            <div class="detail-field-value">${amenity.address}</div>
        </div>
        `;
    }
    
    content += `
        <div class="detail-field">
            <div class="detail-field-label">Coordinates</div>
            <div class="detail-field-value">${amenity.latitude}, ${amenity.longitude}</div>
        </div>
    `;
    
    if (amenity.operator) {
        content += `
        <div class="detail-field">
            <div class="detail-field-label">Operator</div>
            <div class="detail-field-value">${amenity.operator}</div>
        </div>
        `;
    }
    
    if (amenity.hours_of_operation) {
        content += `
            <div class="detail-field">
                <div class="detail-field-label">Hours of Operation</div>
                <div class="detail-field-value">
                    ${formatHours(amenity.hours_of_operation)}
                </div>
            </div>
        `;
    }
    
    if (amenity.changing_stations || amenity.accessibility) {
        let amenities_list = [];
        if (amenity.accessibility) {
            const accessibilityBadge = amenity.accessibility === 'Fully Accessible' ? '♿ Fully Accessible' :
                                       amenity.accessibility === 'Partially Accessible' ? '⚠ Partially Accessible' :
                                       amenity.accessibility === 'Not Accessible' ? '✗ Not Accessible' :
                                       amenity.accessibility;
            amenities_list.push(accessibilityBadge);
        }
        if (amenity.changing_stations) amenities_list.push('Changing Stations');
        
        if (amenities_list.length > 0) {
            content += `
            <div class="detail-field">
                <div class="detail-field-label">Amenities</div>
                <div class="detail-field-value">${amenities_list.join(' • ')}</div>
            </div>
            `;
        }
    }
    
    if (amenity.description) {
        content += `
        <div class="detail-field">
            <div class="detail-field-label">Description</div>
            <div class="detail-field-value">${amenity.description}</div>
        </div>
        `;
    }
    
    contentEl.innerHTML = content;
    panel.classList.add('open');
}

/**
 * Formats the hours of operation from a JSON object into a readable string.
 * @param {object} hours - The hours object from the amenity.
 * @returns {string} - An HTML string representing the hours.
 */
function formatHours(hours) {
    if (typeof hours !== 'object' || hours === null) {
        return hours; // Return as-is if it's a simple string or not an object
    }

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    let output = '<ul class="hours-list">';

    if (hours.default) {
        output += `<li><strong>All Days:</strong> ${formatTimeRange(hours.default)}</li>`;
    } else {
        days.forEach(day => {
            if (hours[day]) {
                output += `<li><strong>${day}:</strong> ${formatTimeRange(hours[day])}</li>`;
            } else if (hours.hasOwnProperty(day) && hours[day] === null) {
                output += `<li><strong>${day}:</strong> Closed</li>`;
            }
        });
    }

    if (hours.notes) {
        output += `<li class="hours-notes">${hours.notes}</li>`;
    }

    output += '</ul>';
    return output;
}

function formatTimeRange(range) {
    if (Array.isArray(range)) {
        return `${range[0]} - ${range[1]}`;
    }
    return range; // For notes or other string values
}

/**
 * Close detail panel
 */
function closeDetailPanel() {
    const panel = document.getElementById('detail-panel');
    panel.classList.remove('open');
    currentDetailAmenity = null;
}

/**
 * Search for locations using Nominatim (OpenStreetMap's geocoding service)
 */
function searchLocations(query) {
    if (query.length < 2) {
        hideSearchResults();
        return;
    }
    
    // Cancel previous request if any
    if (searchAbortController) {
        searchAbortController.abort();
    }
    searchAbortController = new AbortController();
    
    const resultsContainer = document.getElementById('search-results');
    
    // Use Nominatim with CORS-friendly endpoint
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`;
    
    fetch(url, { signal: searchAbortController.signal })
        .then(response => response.json())
        .then(data => {
            if (data.length === 0) {
                resultsContainer.innerHTML = '<div style="padding: 10px 12px; color: #999;">No results found</div>';
                resultsContainer.classList.add('active');
                return;
            }
            
            resultsContainer.innerHTML = data.map((result, index) => `
                <div class="search-result-item" data-index="${index}" data-lat="${result.lat}" data-lon="${result.lon}">
                    <div class="result-name">${result.name}</div>
                    <div class="result-address">${result.display_name}</div>
                </div>
            `).join('');
            
            resultsContainer.classList.add('active');
            
            // Add click handlers to results
            document.querySelectorAll('.search-result-item').forEach(item => {
                item.addEventListener('click', () => {
                    const lat = parseFloat(item.dataset.lat);
                    const lon = parseFloat(item.dataset.lon);
                    const name = item.querySelector('.result-name').textContent;
                    
                    // Pan to location
                    map.setView([lat, lon], 15);
                    
                    // Add or update selected location marker
                    if (selectedLocationMarker) {
                        map.removeLayer(selectedLocationMarker);
                    }
                    selectedLocationMarker = L.marker([lat, lon], {
                        title: name,
                        zIndexOffset: 50,
                        icon: L.icon({
                            iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png',
                            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                            iconSize: [25, 41],
                            iconAnchor: [12, 41],
                            popupAnchor: [1, -34],
                            shadowSize: [41, 41]
                        })
                    }).addTo(map);
                    
                    selectedLocationMarker.bindPopup(name);
                    
                    // Save to history and update search input and hide results
                    saveSearchToHistory(name);
                    document.getElementById('search-input').value = name;
                    hideSearchResults();
                });
            });
        })
        .catch(error => {
            if (error.name !== 'AbortError') {
                console.error('Geocoding error:', error);
            }
        });
}

/**
 * Get search history from localStorage
 */
function getSearchHistory() {
    try {
        const history = localStorage.getItem('mapSearchHistory');
        return history ? JSON.parse(history) : [];
    } catch (e) {
        return [];
    }
}

/**
 * Save search to history
 */
function saveSearchToHistory(query) {
    if (!query || query.trim().length < 2) return;
    
    try {
        let history = getSearchHistory();
        // Remove duplicate if it exists
        history = history.filter(item => item.toLowerCase() !== query.toLowerCase());
        // Add to front
        history.unshift(query);
        // Keep only last 5
        history = history.slice(0, 5);
        localStorage.setItem('mapSearchHistory', JSON.stringify(history));
    } catch (e) {
        console.error('Could not save search history:', e);
    }
}

/**
 * Show search history in results
 */
function showSearchHistory() {
    const resultsContainer = document.getElementById('search-results');
    const history = getSearchHistory();
    
    if (history.length === 0) {
        resultsContainer.innerHTML = '';
        resultsContainer.classList.remove('active');
        return;
    }
    
    resultsContainer.innerHTML = history.map((search, index) => `
        <div class="search-result-item search-history-item" data-index="${index}" data-search="${search}">
            <div class="result-name">🕐 ${search}</div>
        </div>
    `).join('');
    
    resultsContainer.classList.add('active');
    
    // Add click handlers to history items
    document.querySelectorAll('.search-history-item').forEach(item => {
        item.addEventListener('click', () => {
            const search = item.dataset.search;
            document.getElementById('search-input').value = search;
            searchLocations(search);
        });
    });
}

/**
 * Hide search results
 */
function hideSearchResults() {
    const resultsContainer = document.getElementById('search-results');
    resultsContainer.classList.remove('active');
    resultsContainer.innerHTML = '';
}

/**
 * Authentication functions
 */
function showAuthModal() {
    document.getElementById('auth-modal').style.display = 'flex';
}

function closeAuthModal() {
    document.getElementById('auth-modal').style.display = 'none';
    // Clear error messages
    document.getElementById('login-error').style.display = 'none';
    document.getElementById('register-error').style.display = 'none';
}

function switchAuthTab(tabName) {
    document.querySelectorAll('.auth-tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.auth-tab-link').forEach(link => link.classList.remove('active'));

    document.getElementById(tabName).classList.add('active');
    document.querySelector(`.auth-tab-link[data-tab="${tabName}"]`).classList.add('active');

    const title = tabName === 'login-tab' ? 'Login' : 'Sign Up';
    document.getElementById('auth-modal-title').textContent = title;
}

function setupAuthForm(formId, url, errorElId, isRegistration = false) {
    const form = document.getElementById(formId);
    
    const handleSubmit = (e) => {
        e.preventDefault();
        const email = form.querySelector('input[type="email"]').value;
        const password = form.querySelector('input[type="password"]').value;
        const errorEl = document.getElementById(errorElId);
        
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        })
        .then(response => response.json().then(data => ({ status: response.status, body: data })))
        .then(({ status, body }) => {
            if (status >= 400) {
                errorEl.textContent = body.error || 'An unknown error occurred.';
                errorEl.style.display = 'block';
                return;
            }

            // On success, either log in directly (for registration) or handle login
            if (isRegistration) {
                // Automatically log in after successful registration
                handleLogin(email, password);
            } else {
                setCurrentUser(body);
                closeAuthModal();
            }
        })
        .catch(error => {
            console.error('Auth error:', error);
            errorEl.textContent = 'A network error occurred. Please try again.';
            errorEl.style.display = 'block';
        });
    };

    form.addEventListener('submit', handleSubmit);
}

function handleLogin(email, password) {
    const errorEl = document.getElementById('login-error');
    fetch('/api/auth/login/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    })
    .then(response => response.json().then(data => ({ status: response.status, body: data })))
    .then(({ status, body }) => {
        if (status >= 400) {
            errorEl.textContent = body.error || 'Login failed.';
            errorEl.style.display = 'block';
        } else {
            setCurrentUser(body);
            closeAuthModal();
        }
    });
}

function setCurrentUser(userData) {
    currentUser = { id: userData.id, email: userData.email };
    sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
    updateUserUI();
}

function logoutUser() {
    currentUser = null;
    sessionStorage.removeItem('currentUser');
    updateUserUI();
}

function updateUserUI() {
    const authButton = document.getElementById('auth-button');
    const userDisplay = document.getElementById('user-display');

    if (currentUser) {
        userDisplay.textContent = `Welcome, ${currentUser.email}`;
        userDisplay.style.display = 'block';
        authButton.textContent = 'Logout'; // Change text to logout
        // The event listener for logout will be handled in setupAuth
    } else {
        userDisplay.style.display = 'none';
        authButton.textContent = 'Login / Sign Up'; // Change text to login/signup
        // The event listener for showing the modal will be handled in setupAuth
    }
}

function checkLoggedInUser() {
    try {
        const storedUser = sessionStorage.getItem('currentUser');
        if (storedUser) {
            currentUser = JSON.parse(storedUser);
            updateUserUI();
        }
    } catch (e) {
        console.error('Could not parse user from session storage', e);
        sessionStorage.removeItem('currentUser');
    }
}

function setupAuth() {
    const authButton = document.getElementById('auth-button');
    const authModalClose = document.getElementById('auth-modal-close');
    const modalOverlay = document.getElementById('auth-modal');

    authButton.addEventListener('click', () => {
        if (currentUser) {
            logoutUser();
        } else {
            showAuthModal();
        }
    });
    authModalClose.addEventListener('click', closeAuthModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            closeAuthModal();
        }
    });

    // Tab switching
    document.querySelectorAll('.auth-tab-link').forEach(link => {
        link.addEventListener('click', () => {
            switchAuthTab(link.dataset.tab);
        });
    });

    // Form submissions
    setupAuthForm('login-form', '/api/auth/login/', 'login-error');
    setupAuthForm('register-form', '/api/auth/register/', 'register-error', true);

    // Check for logged in user on page load
    checkLoggedInUser();
}

/**
 * Initialize the map when page loads
 */
document.addEventListener('DOMContentLoaded', () => {
    setupAuth();
    initializeGeolocation();
    loadAmenityTypes();
    loadAmenities();

    // Add both marker groups to the map
    map.addLayer(bikeRackMarkers);
    map.addLayer(otherAmenityMarkers);
    
    // Listen for map movements to reload amenities based on visible area
    map.on('moveend', () => {
        loadAmenities();
    });
    
    // Setup location button
    const locationBtn = document.getElementById('location-button');
    locationBtn.addEventListener('click', retryGeolocation);
    
    // Setup detail panel close button
    const detailCloseBtn = document.getElementById('detail-close-btn');
    detailCloseBtn.addEventListener('click', closeDetailPanel);
    
    // Close detail panel when clicking map (but not on markers)
    map.on('click', (e) => {
        if (e.target.tagName !== 'svg') {
            closeDetailPanel();
        }
    });
    
    // Setup include-inactive checkbox
    const includeInactiveCheckbox = document.getElementById('include-inactive');
    includeInactiveCheckbox.addEventListener('change', () => {
        loadAmenities();
    });
    
    // Setup only-accessible checkbox
    const onlyAccessibleCheckbox = document.getElementById('only-accessible');
    onlyAccessibleCheckbox.addEventListener('change', () => {
        loadAmenities();
    });
    
    // Setup search input
    const searchInput = document.getElementById('search-input');
    
    // Show history when focused
    searchInput.addEventListener('focus', () => {
        if (searchInput.value.length === 0) {
            showSearchHistory();
        }
    });
    
    // Handle input changes
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        
        if (e.target.value.length === 0) {
            showSearchHistory();
        } else {
            searchTimeout = setTimeout(() => {
                searchLocations(e.target.value);
            }, 300); // Debounce search
        }
    });
    
    // Hide results when clicking outside
    document.addEventListener('click', (e) => {
        // Make sure not to hide when clicking inside the search section
        if (!e.target.closest('.search-section')) {
            hideSearchResults();
        }
    });
});