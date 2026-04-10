let restoredState = null;
try {
    if (!new URLSearchParams(window.location.search).has('auth_required')) {
        restoredState = JSON.parse(sessionStorage.getItem('mapState'));
    }
} catch (e) { /* ignore */ }

const initialCenter = restoredState ? restoredState.center : [40.73, -73.99];
const initialZoom = restoredState ? restoredState.zoom : 13;

const map = L.map('map', { renderer: L.canvas(), zoomControl: false, zoomSnap: 0 }).setView(initialCenter, initialZoom);

const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const tileUrl = isLocalhost ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' : '/tiles/{z}/{x}/{y}.png';
L.tileLayer(tileUrl, {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    className: 'leaflet-tile-osm',
    keepBuffer: 2,
    updateWhenZooming: false,
    updateWhenIdle: true
}).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const RESTROOM_TYPE  = 'Restroom';
const DAY_NAMES_FULL = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const DAY_ABBR       = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const jsToDbIdx      = jsDay => (jsDay + 6) % 7;

let userLocation           = null;
let userMarker             = null;
let selectedLocationMarker = null;
let bikeRackMarkers        = L.layerGroup();
let otherAmenityMarkers    = L.layerGroup();
let activeAmenityTypes     = new Set();
let allAmenitiesData       = {};
let searchTimeout          = null;
let searchAbortController  = null;
let currentDetailAmenity   = null;
let amenityAbortController = null;
let nearbyHoverMarker      = null;
let pinnedHoverAmenity     = null;
let blockNearbyHover       = false;
let currentUser            = null;
let hoverTooltipTimer      = null;
let pendingAmenityFromQuery = null;

const hoursFilter = {
    openNow:      false,
    selectedDays: new Set([new Date().getDay()]),
    fromMinutes:  0,
    toMinutes:    1439,
};

// Utility function to get CSRF token from cookies
function getCookie(name) {
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.substring(0, name.length + 1) === name + '=') {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}

function initializeGeolocation(shouldSetView = true) {
    const statusEl = document.getElementById('location-status');
    const dotEl    = document.getElementById('location-dot');
    const locBtn   = document.getElementById('location-button');
    if (!navigator.geolocation) { statusEl.textContent = 'Not supported'; return; }
    locBtn.classList.add('locating');
    statusEl.textContent = 'Locating…';
    const tid = setTimeout(() => {
        if (!userLocation) { statusEl.textContent = 'Default location'; locBtn.classList.remove('locating'); if (shouldSetView) map.setView([40.73, -73.99], 13); }
    }, 8000);
    navigator.geolocation.getCurrentPosition(
        ({ coords: { latitude, longitude } }) => {
            clearTimeout(tid);
            userLocation = { latitude, longitude };
            if (shouldSetView) {
                map.setView([latitude, longitude], 15);
            }
            if (userMarker) map.removeLayer(userMarker);
            userMarker = L.marker([latitude, longitude], { title: 'Your Location', zIndexOffset: 100 }).addTo(map);
            userMarker.bindPopup('Your Location');
            statusEl.textContent = 'Location found';
            dotEl.classList.add('found');
            locBtn.classList.remove('locating');
        },
        (err) => {
            clearTimeout(tid);
            locBtn.classList.remove('locating');
            dotEl.classList.add('denied');
            statusEl.textContent = ({ 1: 'no location found', 2: 'Unavailable', 3: 'Timed out' })[err.code] || 'Unable to locate';
            if (shouldSetView) {
                map.setView([40.73, -73.99], 13);
            }
        },
        { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }
    );
}

function retryGeolocation() {
    userLocation = null;
    document.getElementById('location-dot').classList.remove('found', 'denied');
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    
    if (selectedLocationMarker) {
        map.removeLayer(selectedLocationMarker);
        selectedLocationMarker = null;
    }
    const inp = document.getElementById('search-input');
    if (inp) {
        inp.value = '';
        inp.closest('.search-box').classList.remove('has-value');
    }
    initializeGeolocation();
}

const DEFAULT_ACTIVE_TYPES = new Set();

function loadAmenityTypes() {
    const saved = localStorage.getItem('activeAmenityTypes');
    const prev  = saved ? new Set(JSON.parse(saved).map(String)) : null;
    fetch('/api/amenity-types/').then(r => r.json()).then(data => {
        const list = document.getElementById('amenity-list');
        list.innerHTML = '';
        if (!data.types.length) { list.innerHTML = '<p style="color:var(--text-3);font-size:13px">No types yet</p>'; return; }
        const makeItem = (type, sub = false) => {
            const el = document.createElement('div');
            el.className = 'amenity-item' + (sub ? ' sub-item' : '');
            el.dataset.typeId = type.id;
            const checked = prev
                ? prev.has(String(type.id))
                : DEFAULT_ACTIVE_TYPES.has(type.name);
            el.innerHTML = `<input type="checkbox" class="amenity-checkbox" data-type-id="${type.id}" ${checked ? 'checked' : ''}>
                <div class="amenity-color" style="background:${type.color}"></div>
                <span class="amenity-item-label">${type.name}</span>
                <span class="amenity-check-icon">${checked ? '✓' : ''}</span>`;
            const cb = el.querySelector('.amenity-checkbox');
            if (checked) { activeAmenityTypes.add(type.id); el.classList.add('active'); }
            return { el, cb };
        };
        data.types.forEach(type => {
            const { el, cb } = makeItem(type);
            list.appendChild(el);
            if (type.sub_types?.length) {
                const subList = document.createElement('div');
                subList.className = 'amenity-sub-list';
                list.appendChild(subList);
                let anyChecked = false;
                type.sub_types.forEach(st => {
                    const { el: sel, cb: scb } = makeItem(st, true);
                    if (scb.checked) anyChecked = true;
                    subList.appendChild(sel);
                    scb.addEventListener('change', () => { toggleType(st.id, sel, scb); updateHoursFilterVisibility(); });
                });
                subList.style.display = (cb.checked || anyChecked) ? 'flex' : 'none';
            }
            el.addEventListener('click', e => { if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } });
            cb.addEventListener('change', () => {
                const subIds = (type.sub_types || []).map(s => s.id);
                toggleType(type.id, el, cb, subIds);
                if (type.sub_types?.length) {
                    const subList = el.nextElementSibling;
                    subList.style.display = cb.checked ? 'flex' : 'none';
                    subList.querySelectorAll('.amenity-checkbox').forEach(scb => {
                        if (scb.checked !== cb.checked) { scb.checked = cb.checked; scb.dispatchEvent(new Event('change')); }
                    });
                }
                updateHoursFilterVisibility();
            });
        });
        updateHoursFilterVisibility();
        loadAmenities();
    }).catch(e => console.error('Error loading types:', e));
}

function toggleType(typeId, el, cb, subIds = []) {
    const icon = el.querySelector('.amenity-check-icon');
    if (cb.checked) {
        activeAmenityTypes.add(typeId); el.classList.add('active'); if (icon) icon.textContent = '✓';
        subIds.forEach(id => activeAmenityTypes.add(id));
        if (!allAmenitiesData[typeId]) loadAmenities(); else updateDisplayedAmenities();
    } else {
        activeAmenityTypes.delete(typeId); el.classList.remove('active'); if (icon) icon.textContent = '';
        subIds.forEach(id => activeAmenityTypes.delete(id));
        updateDisplayedAmenities();
    }
    localStorage.setItem('activeAmenityTypes', JSON.stringify([...activeAmenityTypes]));
    updateHoursFilterVisibility();
}

function updateHoursFilterVisibility() {
    const section = document.getElementById('hours-filter-section');
    if (!section) return;
    const hasRestroom = [...activeAmenityTypes].some(id => {
        const label = document.querySelector(`.amenity-item[data-type-id="${id}"] .amenity-item-label`);
        return label && label.textContent.trim() === RESTROOM_TYPE;
    });
    section.style.display = hasRestroom ? '' : 'none';
}

function loadAmenities() {
    if (amenityAbortController) amenityAbortController.abort();
    amenityAbortController = new AbortController();

    if (!activeAmenityTypes.size) { 
        allAmenitiesData = {}; 
        updateDisplayedAmenities(); 
        return; 
    }

    const b = map.getBounds();
    const params = new URLSearchParams({
        north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(),
        zoom: Math.round(map.getZoom()),
        include_inactive: document.getElementById('include-inactive').checked,
        only_accessible:  document.getElementById('only-accessible').checked,
    });
    activeAmenityTypes.forEach(id => params.append('type_id', id));
    fetch(`/api/amenities/?${params}`, { signal: amenityAbortController.signal }).then(r => r.json()).then(data => {
        allAmenitiesData = {};
        data.amenities.forEach(a => {
            if (!allAmenitiesData[a.type_id]) allAmenitiesData[a.type_id] = [];
            if (!allAmenitiesData[a.type_id].some(x => x.id === a.id)) allAmenitiesData[a.type_id].push(a);
        });
        updateDisplayedAmenities();
        updateHoursFilterVisibility();
        if (currentDetailAmenity) {
            renderNearbyTab(currentDetailAmenity);
        }
    }).catch(e => { if (e.name !== 'AbortError') console.error('Error loading amenities:', e); });
}

function evaluateHoursFilter(amenity) {
    if (amenity.type !== RESTROOM_TYPE) return { pass: true };
    const h = amenity.hours_of_operation;
    if (!h || typeof h !== 'object' || Object.keys(h).length === 0) return { pass: true };
    if (h.is_24hrs) return { pass: true };
    const now = new Date();
    const activeDays = hoursFilter.openNow ? new Set([now.getDay()]) : hoursFilter.selectedDays;
    if (activeDays.size === 0) {
        if (hoursFilter.fromMinutes === 0 && hoursFilter.toMinutes === 1439) return { pass: true };
        return evalTimeWindow(h, hoursFilter.fromMinutes, hoursFilter.toMinutes);
    }
    for (const jsDay of activeDays) {
        const r = evalDay(h, jsDay, hoursFilter.fromMinutes, hoursFilter.toMinutes, hoursFilter.openNow ? now : null);
        if (r.pass) return r;
    }
    return { pass: false };
}

function evalDay(h, jsDay, fromMins, toMins, nowDate) {
    const dbDay = DAY_NAMES_FULL[jsToDbIdx(jsDay)];
    let val = Object.prototype.hasOwnProperty.call(h, dbDay) ? h[dbDay] : (h.default !== undefined ? h.default : undefined);
    if (val === undefined) return { pass: true };
    if (val === null) return { pass: false };
    if (!Array.isArray(val) || val.length < 2) return { pass: true };
    const openM = parseHHMM(val[0]), closeM = parseHHMM(val[1]);
    if (openM === null || closeM === null) return { pass: true };
    if (nowDate) {
        const nowMins = nowDate.getHours() * 60 + nowDate.getMinutes();
        const open = closeM <= openM ? (nowMins >= openM || nowMins < closeM) : (nowMins >= openM && nowMins < closeM);
        return { pass: open };
    }
    if (fromMins === 0 && toMins === 1439) return { pass: true };
    const overlaps = closeM <= openM ? !(toMins < openM && fromMins > closeM) : (openM < toMins && closeM > fromMins);
    return { pass: overlaps };
}

function evalTimeWindow(h, fromMins, toMins) {
    for (let d = 0; d < 7; d++) { if (evalDay(h, d, fromMins, toMins, null).pass) return { pass: true }; }
    return { pass: false };
}

function parseHHMM(str) {
    if (!str || typeof str !== 'string' || !str.includes(':')) return null;
    const [h, m] = str.split(':').map(Number);
    return (isNaN(h) || isNaN(m)) ? null : h * 60 + m;
}

function updateDisplayedAmenities() {
    bikeRackMarkers.clearLayers();
    otherAmenityMarkers.clearLayers();
    if (!activeAmenityTypes.size) return;
    activeAmenityTypes.forEach(typeId => {
        (allAmenitiesData[typeId] || []).forEach(a => { if (evaluateHoursFilter(a).pass) addAmenityMarker(a); });
    });
    updateFilterChips();
}

function setupHoursFilter() {
    hoursFilter.selectedDays.add(new Date().getDay());
    refreshDayPills();

    document.getElementById('open-now-btn').addEventListener('click', () => {
        hoursFilter.openNow = !hoursFilter.openNow;
        document.getElementById('open-now-btn').classList.toggle('active', hoursFilter.openNow);
        if (hoursFilter.openNow) { hoursFilter.selectedDays.clear(); hoursFilter.selectedDays.add(new Date().getDay()); refreshDayPills(); }
        updateDisplayedAmenities(); updateResetBtn();
    });

    document.querySelectorAll('.day-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            const day = parseInt(btn.dataset.day);
            if (hoursFilter.openNow) { hoursFilter.openNow = false; document.getElementById('open-now-btn').classList.remove('active'); }
            hoursFilter.selectedDays.has(day) ? hoursFilter.selectedDays.delete(day) : hoursFilter.selectedDays.add(day);
            refreshDayPills(); updateDisplayedAmenities(); updateResetBtn();
        });
    });

    const fromEl = document.getElementById('time-from'), toEl = document.getElementById('time-to');
    function syncSliders() {
        document.getElementById('time-from-label').textContent = minsToTime(hoursFilter.fromMinutes);
        document.getElementById('time-to-label').textContent   = minsToTime(hoursFilter.toMinutes);
        fromEl.style.zIndex = hoursFilter.fromMinutes / 1439 > 0.5 ? 5 : 3;
        toEl.style.zIndex   = hoursFilter.fromMinutes / 1439 > 0.5 ? 3 : 5;
        updateRangeFill(); updateDisplayedAmenities(); updateResetBtn();
    }
    fromEl.addEventListener('input', () => {
        let v = parseInt(fromEl.value);
        if (v >= hoursFilter.toMinutes) { v = hoursFilter.toMinutes - 15; fromEl.value = v; }
        hoursFilter.fromMinutes = v; syncSliders();
    });
    toEl.addEventListener('input', () => {
        let v = parseInt(toEl.value);
        if (v <= hoursFilter.fromMinutes) { v = hoursFilter.fromMinutes + 15; toEl.value = v; }
        hoursFilter.toMinutes = v; syncSliders();
    });
    document.getElementById('time-clear').addEventListener('click', resetTimeFilter);
    updateRangeFill();
}

function resetAllFilters() {
    hoursFilter.openNow = false;
    hoursFilter.selectedDays.clear();
    hoursFilter.selectedDays.add(new Date().getDay());
    document.getElementById('open-now-btn').classList.remove('active');
    refreshDayPills();
    hoursFilter.fromMinutes = 0; hoursFilter.toMinutes = 1439;
    document.getElementById('time-from').value = 0;
    document.getElementById('time-to').value   = 1439;
    document.getElementById('time-from-label').textContent = minsToTime(0);
    document.getElementById('time-to-label').textContent   = minsToTime(1439);
    updateRangeFill();
    updateDisplayedAmenities(); updateResetBtn();
}

function resetTimeFilter() {
    hoursFilter.fromMinutes = 0; hoursFilter.toMinutes = 1439;
    document.getElementById('time-from').value = 0;
    document.getElementById('time-to').value   = 1439;
    document.getElementById('time-from-label').textContent = minsToTime(0);
    document.getElementById('time-to-label').textContent   = minsToTime(1439);
    updateRangeFill(); updateDisplayedAmenities(); updateResetBtn();
}

function updateResetBtn() {
    const isDefaultDays = hoursFilter.selectedDays.size === 1 && hoursFilter.selectedDays.has(new Date().getDay());
    const has = hoursFilter.openNow || !isDefaultDays || hoursFilter.fromMinutes !== 0 || hoursFilter.toMinutes !== 1439;
    document.getElementById('reset-filters-btn').classList.toggle('has-filters', has);
}

function refreshDayPills() {
    document.querySelectorAll('.day-pill').forEach(btn => btn.classList.toggle('active', hoursFilter.selectedDays.has(parseInt(btn.dataset.day))));
}

function updateRangeFill() {
    const fill = document.getElementById('range-fill'), pct = v => (v / 1439) * 100;
    fill.style.left  = pct(hoursFilter.fromMinutes) + '%';
    fill.style.right = (100 - pct(hoursFilter.toMinutes)) + '%';
    const nd = hoursFilter.fromMinutes !== 0 || hoursFilter.toMinutes !== 1439;
    document.getElementById('time-from-label').classList.toggle('active', nd);
    document.getElementById('time-to-label').classList.toggle('active', nd);
}

function minsToTime(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function updateFilterChips() {
    const wrap = document.getElementById('filter-chips');
    wrap.innerHTML = '';
    if (hoursFilter.openNow) {
        wrap.appendChild(makeChip('🟢 Open Now', 'green', () => {
            hoursFilter.openNow = false; document.getElementById('open-now-btn').classList.remove('active');
            hoursFilter.selectedDays.clear(); refreshDayPills(); updateDisplayedAmenities();
        }));
    } else if (hoursFilter.selectedDays.size > 0) {
        const labels = [...hoursFilter.selectedDays].sort((a, b) => a - b).map(d => DAY_ABBR[jsToDbIdx(d)]).join(', ');
        wrap.appendChild(makeChip(`📅 ${labels}`, 'blue', () => { hoursFilter.selectedDays.clear(); refreshDayPills(); updateDisplayedAmenities(); }));
    }
    if (hoursFilter.fromMinutes !== 0 || hoursFilter.toMinutes !== 1439) {
        wrap.appendChild(makeChip(`🕐 ${minsToTime(hoursFilter.fromMinutes)} – ${minsToTime(hoursFilter.toMinutes)}`, 'blue', () => resetTimeFilter()));
    }
}

function makeChip(label, cls, onClick) {
    const c = document.createElement('div');
    c.className = `filter-chip ${cls}`;
    c.innerHTML = `${label} <span style="margin-left:4px;opacity:.6">✕</span>`;
    c.addEventListener('click', onClick);
    return c;
}

function setupSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const openBtn = document.getElementById('sidebar-open-btn');
    const body = document.body;
    let isMobileViewport = window.innerWidth <= 768;
    let viewportSwitchTimer = null;

    function collapse() {
        sidebar.classList.add('collapsed');
        openBtn.style.display = 'flex';
        body.classList.remove('sidebar-open');
        requestAnimationFrame(() => map.invalidateSize());
    }

    function expand() {
        sidebar.classList.remove('collapsed');
        openBtn.style.display = 'none';
        body.classList.add('sidebar-open');
        if (window.innerWidth <= 768) {
            closeDetailPanel();
        }
        requestAnimationFrame(() => map.invalidateSize());
    }

    function applyInitialSidebarState() {
        if (window.innerWidth <= 768) {
            collapse();
            return;
        }

        expand();
    }

    document.getElementById('sidebar-toggle').addEventListener('click', collapse);
    openBtn.addEventListener('click', expand);
    window.addEventListener('resize', () => {
        const nextIsMobileViewport = window.innerWidth <= 768;
        if (nextIsMobileViewport === isMobileViewport) return;

        isMobileViewport = nextIsMobileViewport;
        body.classList.add('viewport-switching');
        clearTimeout(viewportSwitchTimer);
        viewportSwitchTimer = setTimeout(() => {
            body.classList.remove('viewport-switching');
        }, 220);
        requestAnimationFrame(() => map.invalidateSize({ pan: false }));
    });

    // Default state based on screen size
    applyInitialSidebarState();
}

const hoverTooltip = (() => {
    const el = document.createElement('div');
    el.id = 'amenity-hover-tooltip';
    Object.assign(el.style, {
        position: 'fixed', zIndex: '9000', pointerEvents: 'auto', cursor: 'pointer',
        background: 'var(--surface,#fff)', border: '1px solid var(--border,#e8e8e5)',
        borderRadius: '12px', boxShadow: '0 8px 32px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.08)',
        minWidth: '220px', maxWidth: '280px', display: 'none', opacity: '0',
        transition: 'opacity .15s ease', fontFamily: "'DM Sans',system-ui,sans-serif", overflow: 'hidden',
    });
    document.body.appendChild(el);

    let currentA = null;
    let showFrameId = null;

    el.addEventListener('click', () => {
        if (currentA) {
            showDetailPanel(currentA);
            hoverTooltip.hide();
        }
    });

    el.addEventListener('mouseenter', () => clearTimeout(hoverTooltipTimer));
    el.addEventListener('mouseleave', () => { hoverTooltipTimer = setTimeout(() => hoverTooltip.hide(), 80); });

    function pos(mx, my) {
        const pad = 16, w = el.offsetWidth || 250, h = el.offsetHeight || 160;
        let x = mx + 18, y = my - 20;
        
        // Check right and left edges
        if (x + w + pad > window.innerWidth) x = mx - w - 18;
        if (x < pad) x = pad;
        
        // Check bottom and top edges
        if (y + h + pad > window.innerHeight) y = window.innerHeight - h - pad;
        if (y < pad) y = pad;
        
        el.style.left = x + 'px'; el.style.top = y + 'px';
    }

    return {
        show(a, mx, my) { 
            currentA = a; 
            el.innerHTML = buildTooltipHtml(a); 
            el.style.display = 'block'; 
            pos(mx, my); 
            if (showFrameId) cancelAnimationFrame(showFrameId);
            showFrameId = requestAnimationFrame(() => el.style.opacity = '1'); 
        },
        move(mx, my)    { if (el.style.display !== 'none') pos(mx, my); },
        hide()          { 
            if (showFrameId) cancelAnimationFrame(showFrameId);
            el.style.opacity = '0'; 
            setTimeout(() => { if (el.style.opacity === '0') el.style.display = 'none'; }, 150); 
        },
        isVisible()         { return el.style.display !== 'none'; },
        getCurrentAmenity() { return currentA; }
    };
})();

function buildTooltipHtml(a) {
    // wifi added for LinkNYC Kiosk
    const icons = { droplet: '💧', restroom: '🚻', bicycle: '🚲', snowflake: '❄️', wifi: '📶' };
    const icon  = icons[a.icon] || '📍';

    const h = a.hours_of_operation;
    let todayRow = '';
    if (h && typeof h === 'object') {
        if (h.is_24hrs) {
            todayRow = `<div class="tt-row"><span class="tt-lbl">Today</span><span class="tt-val" style="color:var(--green,#16a34a);font-weight:600">Open 24 hrs</span></div>`;
        } else {
            const key = DAY_NAMES_FULL[jsToDbIdx(new Date().getDay())];
            const val = Object.prototype.hasOwnProperty.call(h, key) ? h[key] : h.default;
            if (val === null) todayRow = `<div class="tt-row"><span class="tt-lbl">Today</span><span class="tt-val" style="color:var(--red,#dc2626)">Closed</span></div>`;
            else if (Array.isArray(val) && val.length >= 2) todayRow = `<div class="tt-row"><span class="tt-lbl">Today</span><span class="tt-val">${fmt12(val)}</span></div>`;
            else if (h.notes) todayRow = `<div class="tt-row"><span class="tt-lbl">Hours</span><span class="tt-val tt-muted">${h.notes}</span></div>`;
        }
    }

    const addrRow = a.address
        ? `<div class="tt-row"><span class="tt-lbl">Address</span><span class="tt-val">${a.address}</span></div>` : '';

    const posRow = (!a.address && a.position)
        ? `<div class="tt-row"><span class="tt-lbl">Position</span><span class="tt-val">${a.position}</span></div>` : '';

    const operRow = a.operator
        ? `<div class="tt-row"><span class="tt-lbl">Operator</span><span class="tt-val">${a.operator}</span></div>` : '';

    let accessRow = '';
    if (a.accessibility) {
        const aColors = {
            'Fully Accessible':      'var(--green,#16a34a)',
            'Partially Accessible':  'var(--amber,#d97706)',
            'Limited Accessibility': 'var(--amber,#d97706)',
            'Not Accessible':        'var(--red,#dc2626)',
        };
        const col = aColors[a.accessibility] || 'var(--text-2)';
        accessRow = `<div class="tt-row"><span class="tt-lbl">Access</span><span class="tt-val" style="color:${col}">${a.accessibility}</span></div>`;
    }

    let ratingRow = '';
    if (a.rating) {
        const s = Math.round(+a.rating);
        ratingRow = `<div class="tt-row"><span class="tt-lbl">Rating</span><span class="tt-val"><span style="color:#f59e0b">${'★'.repeat(s)}${'☆'.repeat(5-s)}</span> <span class="tt-muted">${(+a.rating).toFixed(1)} (${a.review_count})</span></span></div>`;
    }

    let refLat, refLon, distLabel2;
    if (selectedLocationMarker) {
        const ll = selectedLocationMarker.getLatLng();
        refLat = ll.lat; refLon = ll.lng;
        distLabel2 = 'Distance';
    } else if (userLocation) {
        refLat = userLocation.latitude; refLon = userLocation.longitude;
        distLabel2 = 'Distance';
    } else {
        refLat = map.getCenter().lat; refLon = map.getCenter().lng;
        distLabel2 = 'From center';
    }

    const mi = haversineKm(refLat, refLon, a.latitude, a.longitude) * 0.621371;
    const distStr = mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(2)} mi`;
    const distRow = `<div class="tt-row"><span class="tt-lbl">${distLabel2}</span><span class="tt-val" style="color:var(--accent,#1a6ef5);font-weight:600">${distStr}</span></div>`;

    return `<style>
        #amenity-hover-tooltip .tt-hdr{padding:10px 13px 8px;border-bottom:1px solid var(--border,#e8e8e5)}
        #amenity-hover-tooltip .tt-name{font-size:13px;font-weight:600;color:var(--text-1,#111);margin:0 0 5px;line-height:1.3}
        #amenity-hover-tooltip .tt-type{font-size:11px;font-weight:500;padding:2px 7px;border-radius:20px;background:var(--accent-lt,#e8f0fe);color:var(--accent,#1a6ef5)}
        #amenity-hover-tooltip .tt-body{padding:8px 13px 4px}
        #amenity-hover-tooltip .tt-row{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:4px 0;border-bottom:1px solid var(--border,#e8e8e5);font-size:12px}
        #amenity-hover-tooltip .tt-row:last-child{border-bottom:none}
        #amenity-hover-tooltip .tt-lbl{color:var(--text-3,#999);flex-shrink:0;font-weight:500}
        #amenity-hover-tooltip .tt-val{color:var(--text-1,#111);text-align:right;line-height:1.4}
        #amenity-hover-tooltip .tt-muted{color:var(--text-3,#999)}
        #amenity-hover-tooltip .tt-hint{padding:6px 13px 9px;font-size:11px;color:var(--text-3,#999);font-style:italic;text-align:center}
    </style>
    <div class="tt-hdr">
        <p class="tt-name">${icon} ${a.prop_name || a.name}</p>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="tt-type">${a.type}</span>
            <span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;
                background:${a.active ? 'var(--green-lt,#dcfce7)' : 'var(--red-lt,#fee2e2)'};
                color:${a.active ? 'var(--green,#16a34a)' : 'var(--red,#dc2626)'}">
                ● ${a.active ? 'Active' : 'Inactive'}</span>
        </div>
    </div>
    <div class="tt-body">${distRow}${todayRow}${addrRow}${posRow}${operRow}${accessRow}${ratingRow}</div>
    <div class="tt-hint">Click for full details →</div>`;
}

function addAmenityMarker(amenity) {
    if (amenity.is_cluster) {
        const count = amenity.point_count;
        const cls = 'marker-cluster marker-cluster-' + (count < 10 ? 'small' : count < 100 ? 'medium' : 'large');
        const icon = L.divIcon({ html: `<div style="background:${amenity.color}"><span>${count}</span></div>`, className: cls, iconSize: L.point(40, 40) });
        const m = L.marker([amenity.latitude, amenity.longitude], { icon });
        m.on('click', () => map.flyTo([amenity.latitude, amenity.longitude], map.getZoom() + 2));
        bikeRackMarkers.addLayer(m);
        return;
    }

    const filt = amenity.active ? '' : 'opacity(0.4)';
    let icon;

    if (amenity.icon === 'restroom') {
        icon = L.divIcon({
            // 🚽🧻🚻🚾🚹
            html: `<div style="font-size: 24px; text-shadow: 0 0 3px #fff, 0 0 5px #fff;">🚹</div>`,
            className: 'leaflet-div-icon-custom amenity-marker-icon',
            iconSize: [24, 24],
            iconAnchor: [12, 24],
            popupAnchor: [0, -24],
        });
    } else {
        const svgPaths = {
            droplet:   '<path d="M12 0C8 8,2 14,2 19C2 26.7,6.5 32,12 32C17.5 32,22 26.7,22 19C22 14,16 8,12 0Z"/>',
            bicycle:   '<path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>',
            snowflake: '<path d="M12 2.5l-2.5 4.33h5L12 2.5zm0 19l-2.5-4.33h5L12 21.5zM4.33 7.5L2.5 12l1.83 4.5h4.34L4.33 7.5zm15.34 0L15.33 12l1.83 4.5h4.34L19.67 7.5zM8.67 16.5L12 10l3.33 6.5H8.67zm0-9L12 14l3.33-6.5H8.67z" transform="scale(1.2) translate(-2,-2)"/>',
            // wifi signal bars for LinkNYC Kiosk
            wifi:      '<path d="M12 4C7.6 4 3.6 5.8 0.7 8.7L3.5 11.5C5.7 9.3 8.7 8 12 8C15.3 8 18.3 9.3 20.5 11.5L23.3 8.7C20.4 5.8 16.4 4 12 4ZM12 12C9.8 12 7.8 12.9 6.3 14.4L9.1 17.2C9.9 16.4 11 16 12 16C13 16 14.1 16.4 14.9 17.2L17.7 14.4C16.2 12.9 14.2 12 12 12ZM12 20C10.9 20 10 20.9 10 22C10 23.1 10.9 24 12 24C13.1 24 14 23.1 14 22C14 20.9 13.1 20 12 20Z"/>',
            default:   '<path d="M12 0C8 8,2 14,2 19C2 26.7,6.5 32,12 32C17.5 32,22 26.7,22 19C22 14,16 8,12 0Z"/>',
        };
        icon = L.divIcon({
            html: `<div style="width:24px;height:32px;filter:${filt}">
            <svg viewBox="0 0 24 32" width="24" height="32" xmlns="http://www.w3.org/2000/svg">
                <defs><style>.p${amenity.id}{fill:${amenity.color};stroke:rgba(0,0,0,.22);stroke-width:.5}</style></defs>
                <g class="p${amenity.id}">${svgPaths[amenity.icon] || svgPaths.default}</g>
            </svg></div>`,
            iconSize: [24, 32], iconAnchor: [12, 32], popupAnchor: [0, -32], className: 'leaflet-div-icon-custom amenity-marker-icon',
        });
    }

    const marker = L.marker([amenity.latitude, amenity.longitude], { icon, amenityData: amenity });
    
    // Desktop hover behavior
    marker.on('mouseover', e => { 
        if (window.innerWidth > 768) { clearTimeout(hoverTooltipTimer); hoverTooltip.show(amenity, e.originalEvent.clientX, e.originalEvent.clientY); }
    });
    marker.on('mousemove', e => { 
        if (window.innerWidth > 768) hoverTooltip.move(e.originalEvent.clientX, e.originalEvent.clientY); 
    });
    marker.on('mouseout',  () => { 
        if (window.innerWidth > 768) hoverTooltipTimer = setTimeout(() => hoverTooltip.hide(), 80); 
    });

    marker.on('click', e => {
        if (window.innerWidth <= 768) {
            if (hoverTooltip.isVisible() && hoverTooltip.getCurrentAmenity() === amenity) {
                hoverTooltip.hide();
                showDetailPanel(amenity);
            } else {
                // Calculate position relative to the pin explicitly
                const pt = map.latLngToContainerPoint([amenity.latitude, amenity.longitude]);
                const rect = document.getElementById('map').getBoundingClientRect();
                hoverTooltip.show(amenity, rect.left + pt.x, rect.top + pt.y);
            }
        } else {
            hoverTooltip.hide();
            showDetailPanel(amenity); 
        }
    });

    if (amenity.type === 'Bike Rack' || amenity.type.includes('Bike Rack')) bikeRackMarkers.addLayer(marker);
    else otherAmenityMarkers.addLayer(marker);
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function showDetailPanel(amenity, activeTab = 'overview') {
    currentDetailAmenity = amenity;
    pinnedHoverAmenity = amenity;

    if (!nearbyHoverMarker) {
        nearbyHoverMarker = L.marker([amenity.latitude, amenity.longitude], {
            zIndexOffset: 1000, interactive: false,
            icon: L.icon({
                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-yellow.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
                className: 'hover-pin-bright'
            })
        }).addTo(map);
    } else {
        nearbyHoverMarker.setLatLng([amenity.latitude, amenity.longitude]);
        if (!map.hasLayer(nearbyHoverMarker)) nearbyHoverMarker.addTo(map);
    }

    document.getElementById('detail-name').textContent       = amenity.prop_name || amenity.name;
    document.getElementById('detail-type-badge').textContent = amenity.type;
    renderOverviewTab(amenity);
    renderReviewsTab(amenity);
    renderNearbyTab(amenity);
    switchDetailTab(activeTab);
    const panel = document.getElementById('detail-panel');
    panel.classList.add('open');
    document.body.classList.add('detail-open');

    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('collapsed')) {
            sidebar.classList.add('collapsed');
            const openBtn = document.getElementById('sidebar-open-btn');
            if (openBtn) openBtn.style.display = 'flex';
            document.body.classList.remove('sidebar-open');
        }
    }

    wireFavoriteToggle(amenity);
}

function switchDetailTab(name) {
    document.querySelectorAll('.dp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.dp-tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
    const panel = document.getElementById('detail-panel');
    if (panel) {
        panel.classList.toggle('nearby-active', name === 'nearby');
    }
}

function closeDetailPanel(keepPinned = false) {
    document.getElementById('detail-panel').classList.remove('open');
    document.body.classList.remove('detail-open');
    currentDetailAmenity = null;
    if (!keepPinned) {
        if (nearbyHoverMarker) {
            map.removeLayer(nearbyHoverMarker);
            nearbyHoverMarker = null;
        }
        pinnedHoverAmenity = null;
    }
}

function renderOverviewTab(amenity) {
    const todayIdx = jsToDbIdx(new Date().getDay());
    const isFavorited = Boolean(amenity.is_favorited);
    let html = '';

    html += `<div class="dp-section"><span class="dp-status ${amenity.active ? 'active' : 'inactive'}">${amenity.active ? 'Active' : 'Inactive'}</span></div>`;
    html += `<div class="dp-section" id="availability-section-${amenity.id}">
    <div class="dp-field-label">Is it available right now?</div>
    <div class="avail-loading" style="font-size:12px;color:var(--text-3);">Loading reports…</div>
    </div>`;

    if (currentUser && currentUser.is_authenticated) {
        html += `<div class="dp-section">
            <button type="button" class="dp-favorite-btn ${isFavorited ? 'is-active' : ''}" data-action="toggle-favorite" data-amenity-id="${amenity.id}">
                ${isFavorited ? '★ Remove from favorites' : '☆ Add to favorites'}
            </button>
        </div>`;
    } else {
        html += `<div class="dp-section"><div class="review-login-prompt">Please <a href="#" class="js-open-auth">sign in</a> to save this amenity as a favorite.</div></div>`;
    }

    const locParts = [amenity.prop_name, amenity.position, amenity.address].filter(Boolean);
    if (locParts.length) html += `<div class="dp-section"><div class="dp-field-label">Location</div><div class="dp-field-value">${locParts.join(' · ')}</div></div>`;
    if (amenity.operator) html += `<div class="dp-section"><div class="dp-field-label">Operated by</div><div class="dp-field-value">${amenity.operator}</div></div>`;

    if (amenity.hours_of_operation && Object.keys(amenity.hours_of_operation).length) {
        html += `<div class="dp-section"><div class="dp-field-label">Hours of Operation</div><div class="hours-grid">${buildHoursGrid(amenity.hours_of_operation, todayIdx)}</div></div>`;
    }

    const feats = [];
    if (amenity.accessibility) {
        const aMap = {
            'Fully Accessible':      ['full',    '♿ Fully Accessible'],
            'Partially Accessible':  ['partial', '⚠ Partially Accessible'],
            'Limited Accessibility': ['limited', '⚠ Limited Accessibility'],
            'Not Accessible':        ['none',    '✗ Not Accessible'],
        };
        const [cls, lbl] = aMap[amenity.accessibility] || ['', amenity.accessibility];
        feats.push(`<span class="access-badge ${cls}">${lbl}</span>`);
    }
    if (amenity.changing_stations) feats.push('<span class="access-badge">🚼 Changing Stations</span>');
    if (feats.length) html += `<div class="dp-section"><div class="dp-field-label">Features</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">${feats.join('')}</div></div>`;

    if (amenity.rating) {
        const s = Math.round(amenity.rating);
        html += `<div class="dp-section"><div class="dp-field-label">Rating</div>
            <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:15px;color:#f59e0b">${'★'.repeat(s)}${'☆'.repeat(5 - s)}</span>
                <span style="font-size:13px;color:var(--text-2)">${(+amenity.rating).toFixed(1)} · ${amenity.review_count} review${amenity.review_count !== 1 ? 's' : ''}</span>
            </div></div>`;
    }

    if (amenity.description) html += `<div class="dp-section"><div class="dp-field-label">Notes</div><div class="dp-field-value" style="font-size:12px;color:var(--text-2);line-height:1.5">${amenity.description}</div></div>`;

    html += `<div class="dp-section"><div class="dp-field-label">Coordinates</div><div class="dp-field-value" style="font-family:var(--mono);font-size:12px;color:var(--text-2)">${amenity.latitude.toFixed(5)}, ${amenity.longitude.toFixed(5)}</div></div>`;

    let origin = '';
    if (selectedLocationMarker) {
        const { lat, lng } = selectedLocationMarker.getLatLng();
        origin = `&origin=${lat},${lng}`;
    }
    const walkUrl  = `https://www.google.com/maps/dir/?api=1&destination=${amenity.latitude},${amenity.longitude}${origin}&travelmode=walking`;
    const bikeUrl  = `https://www.google.com/maps/dir/?api=1&destination=${amenity.latitude},${amenity.longitude}${origin}&travelmode=bicycling`;
    html += `<div class="dp-section"><div class="dp-nav">
        <a href="${walkUrl}" target="_blank" class="dp-nav-btn">🚶 Walk there</a>
        <a href="${bikeUrl}" target="_blank" class="dp-nav-btn">🚴 Bike there</a>
    </div></div>`;

    document.getElementById('tab-overview').innerHTML = html;
    loadAvailabilitySection(amenity);

    const loginLink = document.querySelector('#tab-overview .js-open-auth');
    if (loginLink) {
        loginLink.addEventListener('click', e => {
            e.preventDefault();
            switchAuthTab('login-tab');
            showAuthModal();
        });
    }
}

function loadAvailabilitySection(amenity) {
    fetch(`/api/amenities/${amenity.id}/availability/`)
        .then(r => r.json())
        .then(data => {
            const section = document.getElementById(`availability-section-${amenity.id}`);
            if (!section) return;

            const total = data.total || 0;
            const availPct = total > 0 ? Math.round((data.available / total) * 100) : null;
            const userVote = data.user_vote;

            let timeAgo = '';
            if (data.last_reported) {
                const mins = Math.round((Date.now() - new Date(data.last_reported)) / 60000);
                timeAgo = mins < 2 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins/60)}h ago`;
            }

            const barHtml = total > 0 ? `
                <div style="margin:8px 0 6px;">
                    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);margin-bottom:4px;">
                        <span style="color:var(--green)">✓ Available · ${data.available}</span>
                        <span style="color:var(--red)">✗ Unavailable · ${data.unavailable}</span>
                    </div>
                    <div style="height:6px;border-radius:3px;background:var(--red-lt);overflow:hidden;">
                        <div style="height:100%;width:${availPct}%;background:var(--green);border-radius:3px;transition:width .3s ease;"></div>
                    </div>
                    <div style="font-size:11px;color:var(--text-3);margin-top:4px;">${total} report${total !== 1 ? 's' : ''} · last ${timeAgo} · resets every 3h</div>
                </div>` : `<div style="font-size:12px;color:var(--text-3);margin:6px 0 8px;">No reports yet in the last 3 hours. Be the first!</div>`;

            const availActive = userVote === 'available';
            const unavailActive = userVote === 'unavailable';

            section.innerHTML = `
                <div class="dp-field-label">Is it available right now?</div>
                ${barHtml}
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px;">
                    <button type="button" class="avail-btn" data-vote="true"
                        style="padding:9px 0;border-radius:8px;border:1.5px solid ${availActive ? 'var(--green)' : 'var(--border)'};
                               background:${availActive ? 'var(--green-lt)' : 'var(--surface2)'};
                               color:${availActive ? 'var(--green)' : 'var(--text-2)'};
                               font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer;transition:all .15s ease;">
                        ✓ Available${availActive ? ' ✓' : ''}
                    </button>
                    <button type="button" class="avail-btn" data-vote="false"
                        style="padding:9px 0;border-radius:8px;border:1.5px solid ${unavailActive ? 'var(--red)' : 'var(--border)'};
                               background:${unavailActive ? 'var(--red-lt)' : 'var(--surface2)'};
                               color:${unavailActive ? 'var(--red)' : 'var(--text-2)'};
                               font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer;transition:all .15s ease;">
                        ✗ Unavailable${unavailActive ? ' ✓' : ''}
                    </button>
                </div>`;

            section.querySelectorAll('.avail-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const isAvailable = btn.dataset.vote === 'true';
                    btn.disabled = true;
                    btn.textContent = 'Saving…';
                    fetch(`/api/amenities/${amenity.id}/availability/report/`, {
                        method: 'POST',
                        headers: {
                        'Content-Type': 'application/json',
                        'X-CSRFToken': getCookie('csrftoken'),
                        },
                        credentials: 'same-origin',
                        body: JSON.stringify({ is_available: isAvailable }),
                    })
                    .then(r => r.json())
                    .then(d => {
                        if (d.ok) {
                            showToast(isAvailable ? 'Marked as available!' : 'Marked as unavailable.', isAvailable ? 'success' : 'warn');
                            loadAvailabilitySection(amenity);
                        }
                    })
                    .catch(() => showToast('Could not save report.', 'error'));
                });
            });
        })
        .catch(() => {
            const section = document.getElementById(`availability-section-${amenity.id}`);
            if (section) section.querySelector('.avail-loading').textContent = 'Could not load availability.';
        });
}

function wireFavoriteToggle(amenity) {
    const favoriteButton = document.querySelector('#tab-overview [data-action="toggle-favorite"]');
    if (!favoriteButton) return;

    favoriteButton.addEventListener('click', () => {
        toggleAmenityFavorite(amenity, favoriteButton);
    });
}

function updateAmenityFavoriteStateInCache(amenityId, isFavorited) {
    Object.values(allAmenitiesData).forEach(items => {
        items.forEach(item => {
            if (Number(item.id) === Number(amenityId)) {
                item.is_favorited = isFavorited;
            }
        });
    });
}

function toggleAmenityFavorite(amenity, buttonEl) {
    if (!currentUser || !currentUser.is_authenticated) {
        showToast('Please sign in to save favorites.', 'warn');
        return;
    }

    const isCurrentlyFavorited = Boolean(amenity.is_favorited);
    const method = isCurrentlyFavorited ? 'DELETE' : 'POST';

    buttonEl.disabled = true;

    fetch(`/api/amenities/${amenity.id}/favorite/`, {
        method,
        credentials: 'same-origin',
    })
        .then(r => r.json().then(b => ({ s: r.status, b })).catch(() => ({ s: r.status, b: {} })))
        .then(({ s, b }) => {
            if (s >= 400) {
                showToast(b.error || 'Unable to update favorite.', 'error');
                return;
            }

            const nextValue = Boolean(b.is_favorited);
            amenity.is_favorited = nextValue;
            updateAmenityFavoriteStateInCache(amenity.id, nextValue);

            if (currentDetailAmenity && Number(currentDetailAmenity.id) === Number(amenity.id)) {
                currentDetailAmenity.is_favorited = nextValue;
            }

            renderOverviewTab(amenity);
            wireFavoriteToggle(amenity);
            showToast(nextValue ? 'Added to favorites.' : 'Removed from favorites.', 'success');
        })
        .catch(() => {
            showToast('Network error while updating favorite.', 'error');
        })
        .finally(() => {
            buttonEl.disabled = false;
        });
}

function renderNearbyTab(a) {
    const pane  = document.getElementById('tab-nearby');
    const icons = { droplet: '💧', restroom: '🚻', bicycle: '🚲', snowflake: '❄️', wifi: '📶' };
    const icon  = icons[a.icon] || '📍';

    const candidates = [];
    Object.values(allAmenitiesData).flat().forEach(x => {
        if (x.id === a.id || x.type !== a.type) return;
        if (!x.is_cluster && !evaluateHoursFilter(x).pass) return;
        const km = haversineKm(a.latitude, a.longitude, x.latitude, x.longitude);
        candidates.push({ x, km });
    });
    candidates.sort((p, q) => p.km - q.km);
    const nearby = candidates.slice(0, 8);

    const fromLabel = `Closest other ${a.type}s · distances from <em>this location</em>`;

    if (!nearby.length) {
        pane.innerHTML = `<div class="nearby-header">${fromLabel}</div><div class="nearby-empty">None loaded yet — pan or zoom to find more.</div>`;
        return;
    }

    const rows = nearby.map(({ x, km }) => {
        const mi   = km * 0.621371;
        const dist = mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(2)} mi`;
        if (x.is_cluster) {
            return `<div class="nearby-card" data-id="${x.id}">
                <div class="nearby-icon">${icon}</div>
                <div class="nearby-info">
                    <div class="nearby-name">${x.point_count} ${x.type}s</div>
                    <div class="nearby-meta"><span style="color:var(--text-3);font-size:10px">●</span> Cluster</div>
                </div>
                <div class="nearby-dist">${dist}</div>
            </div>`;
        }
        const dot  = x.active ? '<span style="color:var(--green);font-size:10px">●</span>' : '<span style="color:var(--text-3);font-size:10px">●</span>';
        return `<div class="nearby-card" data-id="${x.id}">
            <div class="nearby-icon">${icon}</div>
            <div class="nearby-info">
                <div class="nearby-name">${x.prop_name || x.name}</div>
                <div class="nearby-meta">${dot} ${x.active ? 'Active' : 'Inactive'}${x.address ? ' · ' + x.address : ''}</div>
            </div>
            <div class="nearby-dist">${dist}</div>
        </div>`;
    }).join('');

    pane.innerHTML = `<div class="nearby-header">${fromLabel}</div><div class="nearby-list">${rows}</div>`;
    pane.querySelectorAll('.nearby-card').forEach(card => {
        const found = Object.values(allAmenitiesData).flat().find(x => String(x.id) === String(card.dataset.id));
        if (!found) return;

        card.addEventListener('mouseenter', () => {
            if (blockNearbyHover) return;

            if (!nearbyHoverMarker) {
                nearbyHoverMarker = L.marker([found.latitude, found.longitude], {
                    zIndexOffset: 1000, interactive: false,
                    icon: L.icon({
                        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-yellow.png',
                        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                        iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
                        className: 'hover-pin-bright'
                    })
                }).addTo(map);
            } else {
                nearbyHoverMarker.setLatLng([found.latitude, found.longitude]);
                if (!map.hasLayer(nearbyHoverMarker)) nearbyHoverMarker.addTo(map);
            }
        });
        card.addEventListener('mouseleave', () => {
            if (blockNearbyHover) return;
            
            if (pinnedHoverAmenity) {
                nearbyHoverMarker.setLatLng([pinnedHoverAmenity.latitude, pinnedHoverAmenity.longitude]);
                if (!map.hasLayer(nearbyHoverMarker)) nearbyHoverMarker.addTo(map);
            } else {
                if (nearbyHoverMarker) { map.removeLayer(nearbyHoverMarker); nearbyHoverMarker = null; }
            }
        });

        let pressTimer;
        let isLongPress = false;
        let isTouchMoved = false;

        card.addEventListener('touchstart', (e) => {
            if (window.innerWidth > 768) return;
            isLongPress = false;
            isTouchMoved = false;
            pressTimer = setTimeout(() => {
                if (isTouchMoved) return;
                isLongPress = true;
                
                // Visual pop and Android haptic feedback
                card.style.transform = 'scale(0.96)';
                setTimeout(() => { card.style.transform = ''; }, 150);
                if (navigator.vibrate) navigator.vibrate(50);
                
                if (found.is_cluster) {
                    map.flyTo([found.latitude, found.longitude], map.getZoom() + 2);
                    closeDetailPanel();
                } else {
                    map.flyTo([found.latitude, found.longitude], map.getZoom()); showDetailPanel(found, 'nearby');
                }
            }, 500);
        }, { passive: true });

        card.addEventListener('touchmove', () => {
            if (window.innerWidth > 768) return;
            isTouchMoved = true;
            clearTimeout(pressTimer);
        }, { passive: true });

        card.addEventListener('touchend', () => {
            if (window.innerWidth > 768) return;
            clearTimeout(pressTimer);
        });

        card.addEventListener('contextmenu', e => {
            if (window.innerWidth <= 768) e.preventDefault();
        });

        card.addEventListener('click', (e) => {
            if (window.innerWidth <= 768) {
                if (isLongPress) {
                    e.preventDefault();
                    return;
                }
                
                // Mobile Short Tap (Preview)
                if (!nearbyHoverMarker) {
                    nearbyHoverMarker = L.marker([found.latitude, found.longitude], {
                        zIndexOffset: 1000, interactive: false,
                        icon: L.icon({
                            iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-yellow.png',
                            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                            iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
                            className: 'hover-pin-bright'
                        })
                    }).addTo(map);
                } else {
                    nearbyHoverMarker.setLatLng([found.latitude, found.longitude]);
                    if (!map.hasLayer(nearbyHoverMarker)) nearbyHoverMarker.addTo(map);
                }
                pinnedHoverAmenity = found;
                return;
            }

            // Desktop Click (Select)
            blockNearbyHover = true;
            document.addEventListener('mousemove', () => { blockNearbyHover = false; }, { once: true });
            
            if (found.is_cluster) {
                map.flyTo([found.latitude, found.longitude], map.getZoom() + 2);
                closeDetailPanel();
            } else {
                map.flyTo([found.latitude, found.longitude], map.getZoom()); showDetailPanel(found, 'nearby');
            }
        });
    });
}

function renderReviewsTab(amenity) {
    const pane = document.getElementById('tab-reviews');

    const typeEmojis = {
        restroom:  '🚻',
        droplet:   '💧',
        bicycle:   '🚲',
        snowflake: '❄️',
        wifi:      '📶',
    };
    const emoji = typeEmojis[amenity.icon] || '📍';

    const typeDescriptions = {
        'Restroom':        'Public restrooms are toilet facilities available for public use throughout New York City parks, plazas, and buildings.',
        'Water Fountain':  'Drinking water fountains provide free access to clean, potable water for all New Yorkers and visitors across the city.',
        'Bike Rack':       'Bike racks offer secure parking spots for bicycles, making cycling a convenient option for getting around the city.',
        'Cooling Center':  'Cooling centers provide a free, air-conditioned refuge during heat emergencies, helping New Yorkers stay safe in extreme heat.',
        'LinkNYC Kiosk':   'LinkNYC kiosks offer free ultrafast public Wi-Fi, free domestic calls, device charging, and access to city services — all at no cost.',
    };
    const description = typeDescriptions[amenity.type]
        || `A public ${amenity.type.toLowerCase()} available to all New York City residents and visitors.`;

    const heroColor = (amenity.color || '#1a6ef5') + '22';
    let html = `
        <div class="rv-hero" style="background:${heroColor}">
            <div class="rv-hero-emoji">${emoji}</div>
            <div class="rv-hero-type">${amenity.type}</div>
        </div>`;

    html += `<div class="dp-section">
        <div class="dp-field-label">About this amenity</div>
        <div class="rv-description">${description}</div>
    </div>`;

    const hasRating = amenity.rating !== null && amenity.rating !== undefined && Number(amenity.review_count || 0) > 0;
    html += `<div class="dp-section">
        <div class="dp-field-label">Community Rating</div>
        <div class="rv-rating-row">`;

    if (hasRating) {
        const avg = +amenity.rating;
        const filled = Math.round(avg);
        const stars  = '★'.repeat(filled) + '☆'.repeat(5 - filled);
        const totalReviews = amenity.review_count || 0;

        html += `<div class="rv-rating-left">
                    <span class="rv-rating-big">${avg.toFixed(1)}</span>
                    <div class="rv-stars">${stars}</div>
                    <div class="rv-count">${totalReviews} review${totalReviews !== 1 ? 's' : ''}</div>
                </div>
                <div class="rv-rating-right">
                    <div class="rating-histo-container">
                        <div class="loading-spinner"></div>
                    </div>
                </div>`;
    } else {
        html += `<div class="rv-rating-left">
                    <span class="rv-rating-big" style="font-size:26px">-</span>
                    <div class="rv-stars">☆☆☆☆☆</div>
                    <div class="rv-count">No ratings yet</div>
                </div>
                <div class="rv-rating-right">
                    <div class="rating-histo">`;
        for (let i = 5; i >= 1; i--) {
             html += `<div class="rating-histo-row">
                        <div class="rating-histo-label">${i} ★</div>
                        <div class="rating-histo-bar-wrap">
                            <div class="rating-histo-bar" style="width: 0%"></div>
                        </div>
                         <div class="rating-histo-count">0</div>
                    </div>`;
        }
        html += `</div></div>`;
    }
    html += `</div></div>`;

    const reviews = amenity.reviews || [];
    const loggedIn = currentUser && currentUser.is_authenticated;
    const currentEmail = (currentUser?.email || '').toLowerCase();
    const alreadyReviewed = loggedIn && reviews.some(r => (r.user_email || r.user_name || '').toLowerCase() === currentEmail);

    if (!loggedIn) {
        html += `<div class="review-login-prompt">Please <a href="#" class="js-open-auth">sign in</a> to add a review.</div>`;
    } else if (alreadyReviewed) {
        html += `<div class="review-login-prompt">You have already reviewed this location.</div>`;
    } else {
        html += `<div class="review-write">
            <div class="review-write-title">Write a Review</div>
            <div class="star-picker js-star-picker" data-rating="5">
                <button type="button" class="star-btn lit" data-value="1" aria-label="Rate 1 star">★</button>
                <button type="button" class="star-btn lit" data-value="2" aria-label="Rate 2 stars">★</button>
                <button type="button" class="star-btn lit" data-value="3" aria-label="Rate 3 stars">★</button>
                <button type="button" class="star-btn lit" data-value="4" aria-label="Rate 4 stars">★</button>
                <button type="button" class="star-btn lit" data-value="5" aria-label="Rate 5 stars">★</button>
            </div>
            <textarea class="review-textarea js-review-text" rows="3" maxlength="600" placeholder="Share your experience at this location (optional)..."></textarea>
            <div style="margin-top:12px">
                <label style="display:block;font-size:12px;color:var(--text-2);margin-bottom:6px;font-weight:500">Add Photos (optional)</label>
                <p style="font-size:11px;color:var(--text-3);margin:0 0 6px 0">Max 5MB per photo, up to 5 photos</p>
                <input type="file" class="js-review-photos" accept="image/*" multiple style="font-size:12px;color:var(--text-2)">
                <div class="js-photo-preview" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:8px;margin-top:8px"></div>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:12px">
                <button type="button" class="review-submit js-review-submit">Submit Review</button>
            </div>
        </div>`;
    }

    if (reviews.length) {
        const byVote = [...reviews].sort(compareReviewsByVotes);
        const top = byVote[0];
        const stars = '★'.repeat(top.rating) + '☆'.repeat(5 - top.rating);
        const date  = new Date(top.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        const topReviewerName = getReviewerName(top);
        const isTopOtherUser = loggedIn && currentEmail !== (top.user_email || '').toLowerCase();
        html += `<div class="dp-section">
            <div class="dp-field-label">Top Voted Review</div>
            <div class="rv-review-card">
                <div class="rv-review-header">
                    ${renderReviewerAvatar(top)}
                    <div class="rv-review-meta">
                        <div class="rv-reviewer ${isTopOtherUser ? 'clickable-username' : ''}" 
                            data-user-email="${top.user_email || top.user_name}">
                            ${topReviewerName}
                        </div>
                        <div class="rv-review-stars">${stars}</div>
                    </div>
                    <div class="rv-review-date">${date}</div>
                </div>
                <div class="rv-review-text">${top.review_text || 'No written comment.'}</div>
                ${renderVoteControls(top, loggedIn, currentEmail, true)}
                ${renderReviewPhotos(top)}
            </div>
        </div>`;

        const otherReviews = byVote.filter(r => r !== top);
        if (otherReviews.length) {
            html += `<div class="dp-section">
                <div class="dp-field-label">Recent Reviews</div>
                <div class="review-list">${otherReviews.map(r => {
                    const reviewerName = getReviewerName(r);
                    const rStars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
                    const rDate = new Date(r.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
                    const isOtherUser = loggedIn && currentEmail !== (r.user_email || '').toLowerCase();
                    return `<div class="review-card">
                        <div class="review-card-top">
                            <div class="review-reviewer-row">
                                ${renderReviewerAvatar(r, 'review-avatar')}
                                <div class="review-user ${isOtherUser ? 'clickable-username' : ''}" 
                                    data-user-email="${r.user_email || r.user_name}">
                                    ${reviewerName}
                                </div>
                            </div>

                            <div class="review-date">${rDate}</div>
                        </div>
                        <div class="review-stars">${rStars}</div>
                        <div class="review-text">${r.review_text || 'No written comment.'}</div>
                        ${renderVoteControls(r, loggedIn, currentEmail)}
                        ${renderReviewPhotos(r)}
                    </div>`;
                }).join('')}</div>
            </div>`;
        }
    } else {
        html += `<div class="dp-section"><div class="rv-empty">No reviews yet for this location.<br>Be the first to share your experience!</div></div>`;
    }

    pane.innerHTML = html;

    if (hasRating) {
        fetch(`/api/amenities/${amenity.id}/rating-distribution/`)
            .then(response => response.json())
            .then(data => {
                const histoContainer = pane.querySelector('.rating-histo-container');
                if (!histoContainer) return;

                const distribution = data.rating_distribution || [];
                const ratingCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
                let maxCount = 0;

                distribution.forEach(item => {
                    const rating = Math.round(Number(item.rating));
                    if (rating >= 1 && rating <= 5) {
                        ratingCounts[rating] = item.count;
                        if (item.count > maxCount) {
                            maxCount = item.count;
                        }
                    }
                });

                let histoHtml = '<div class="rating-histo">';
                for (let i = 5; i >= 1; i--) {
                    const count = ratingCounts[i];
                    const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0;
                    histoHtml += `<div class="rating-histo-row">
                                <div class="rating-histo-label">${i}</div>
                                <div class="rating-histo-bar-wrap">
                                    <div class="rating-histo-bar" style="width: ${percentage}%"></div>
                                </div>
                            </div>`;
                }
                histoHtml += '</div>';
                histoContainer.innerHTML = histoHtml;
            }).catch(e => {
                const histoContainer = pane.querySelector('.rating-histo-container');
                if (histoContainer) {
                    histoContainer.innerHTML = '<div class="rv-count">Could not load rating details.</div>';
                }
                console.error('Failed to load rating distribution', e);
            });
    }

    // Setup clickable usernames for messaging
    pane.querySelectorAll('.clickable-username').forEach(username => {
        username.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const userEmail = username.dataset.userEmail;
            showMessagingMenu(userEmail, amenity);
        });
    });

    const loginLink = pane.querySelector('.js-open-auth');
    if (loginLink) {
        loginLink.addEventListener('click', e => {
            e.preventDefault();
            switchAuthTab('login-tab');
            showAuthModal();
        });
    }

    const submitBtn = pane.querySelector('.js-review-submit');
    if (submitBtn) {
        submitBtn.addEventListener('click', () => submitReview(amenity, pane));
    }

    attachVoteHandlers(amenity, pane);
    attachReviewPhotoCarousels(pane);

    const starPicker = pane.querySelector('.js-star-picker');
    if (starPicker) {
        const stars = starPicker.querySelectorAll('.star-btn');
        stars.forEach(star => {
            star.addEventListener('click', () => {
                const selected = parseInt(star.dataset.value, 10);
                starPicker.dataset.rating = String(selected);
                stars.forEach(s => s.classList.toggle('lit', parseInt(s.dataset.value, 10) <= selected));
            });
        });
    }

    // Handle multiple photo uploads with preview
    const photoInput = pane.querySelector('.js-review-photos');
    if (photoInput) {
        photoInput.addEventListener('change', () => {
            updatePhotoPreview(pane);
        });
    }
}

function updatePhotoPreview(pane) {
    const photoInput = pane.querySelector('.js-review-photos');
    const previewContainer = pane.querySelector('.js-photo-preview');
    if (!photoInput || !previewContainer) return;

    const files = Array.from(photoInput.files);
    if (files.length > 5) {
        const dt = new DataTransfer();
        files.slice(0, 5).forEach(file => dt.items.add(file));
        photoInput.files = dt.files;
        showToast('You can upload up to 5 photos per review.', 'warn');
    }

    const previewFiles = Array.from(photoInput.files);
    previewContainer.innerHTML = '';

    previewFiles.forEach((file, index) => {
        // Validate file size
        const maxSize = 5 * 1024 * 1024;
        if (file.size > maxSize) {
            showToast(`Photo "${file.name}" exceeds 5MB limit and will be skipped`, 'warn');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const thumb = document.createElement('div');
            thumb.className = 'photo-thumb';
            thumb.style.cssText = 'position:relative;border-radius:4px;overflow:hidden;background:#f0f0f0;aspect-ratio:1;cursor:pointer';
            thumb.innerHTML = `
                <img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;display:block">
                <button type="button" class="photo-thumb-delete" data-index="${index}" 
                    style="position:absolute;top:2px;right:2px;background:#ff4444;color:white;border:none;border-radius:3px;width:20px;height:20px;padding:0;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center">×</button>
            `;
            previewContainer.appendChild(thumb);

            thumb.querySelector('.photo-thumb-delete').addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                const dt = new DataTransfer();
                Array.from(photoInput.files).forEach((f, i) => {
                    if (i !== index) dt.items.add(f);
                });
                photoInput.files = dt.files;
                updatePhotoPreview(pane);
            });
        };
        reader.readAsDataURL(file);
    });

    if (previewFiles.length > 0) {
        // Show file count
        if (previewContainer.previousElementSibling && previewContainer.previousElementSibling.classList.contains('photo-count')) {
            previewContainer.previousElementSibling.remove();
        }
        const countEl = document.createElement('p');
        countEl.className = 'photo-count';
        countEl.style.cssText = 'font-size:11px;color:var(--text-3);margin:0 0 6px 0';
        countEl.textContent = `${previewFiles.length} photo${previewFiles.length !== 1 ? 's' : ''} selected`;
        previewContainer.parentNode.insertBefore(countEl, previewContainer);
    } else if (previewContainer.previousElementSibling && previewContainer.previousElementSibling.classList.contains('photo-count')) {
        previewContainer.previousElementSibling.remove();
    }
}

function submitReview(amenity, pane) {
    if (!currentUser || !currentUser.is_authenticated) {
        showToast('Please sign in to add a review.', 'warn');
        return;
    }

    const textEl = pane.querySelector('.js-review-text');
    const starPicker = pane.querySelector('.js-star-picker');
    const photoInput = pane.querySelector('.js-review-photos');
    const btn = pane.querySelector('.js-review-submit');
    if (!textEl || !btn || !starPicker) return;

    const rating = Math.min(5, Math.max(1, parseInt(starPicker.dataset.rating || '5', 10) || 5));
    const reviewText = textEl.value.trim();

    btn.disabled = true;
    btn.textContent = 'Submitting...';

    const formData = new FormData();
    formData.append('amenity_id', String(amenity.id));
    formData.append('rating', String(rating));
    formData.append('review_text', reviewText);

    // Add all selected photos
    if (photoInput && photoInput.files) {
        const files = Array.from(photoInput.files).slice(0, 5);
        files.forEach(file => {
            formData.append('photos', file);
        });
    }

    fetch('/api/reviews/', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
    })
        .then(r => r.json().then(b => ({ s: r.status, b })).catch(() => ({ s: r.status, b: {} })))
        .then(({ s, b }) => {
            if (s >= 400) {
                showToast(b.error || 'Unable to submit review.', 'error');
                btn.disabled = false;
                btn.textContent = 'Submit Review';
                return;
            }

            const newReview = {
                id: b.id,
                user_name: b.user_name || currentUser.username || currentUser.email || 'You',
                user_email: b.user_email || currentUser.email || '',
                user_avatar_url: b.user_avatar_url || currentUser.avatar_url || '',
                rating: b.rating || rating,
                vote_score: Number(b.vote_score || 0),
                user_vote: Number(b.user_vote || 0),
                review_text: b.review_text || reviewText,
                photo_url: b.photo_url || null,  // Backward compatibility
                photo_urls: b.photo_urls || (b.photo_url ? [b.photo_url] : []),
                created_at: b.created_at || new Date().toISOString(),
            };

            if (!Array.isArray(amenity.reviews)) amenity.reviews = [];
            amenity.reviews.unshift(newReview);
            amenity.reviews = amenity.reviews.slice(0, 5);

            const prevCount = Number(amenity.review_count || 0);
            const prevAvg = Number(amenity.rating || 0);
            amenity.review_count = prevCount + 1;
            amenity.rating = prevCount > 0
                ? ((prevAvg * prevCount) + newReview.rating) / amenity.review_count
                : newReview.rating;

            renderOverviewTab(amenity);
            renderReviewsTab(amenity);
            switchDetailTab('reviews');
            showToast('Review added. Thanks for sharing!', 'success');
        })
        .catch(() => {
            showToast('Network error while submitting review.', 'error');
            btn.disabled = false;
            btn.textContent = 'Submit Review';
        });
}

function buildHoursGrid(hours, todayIdx) {
    if (hours.is_24hrs) return '<span class="hours-badge">🕐 Open 24 Hours</span>';
    if (hours.notes && Object.keys(hours).filter(k => k !== 'notes').length === 0) return `<span class="hours-note">${hours.notes}</span>`;
    let out = '', hasAnyDay = false;
    DAY_NAMES_FULL.forEach((day, i) => {
        let val;
        if (Object.prototype.hasOwnProperty.call(hours, day)) val = hours[day];
        else if (hours.default !== undefined) val = hours.default;
        else return;
        hasAnyDay = true;
        const isToday = i === todayIdx;
        let timeEl;
        if (val === null) timeEl = '<span class="hours-closed">Closed</span>';
        else if (Array.isArray(val) && val.length >= 2) {
            const o = parseHHMM(val[0]), c = parseHHMM(val[1]);
            timeEl = (o !== null && c !== null) ? `<span class="hours-time">${fmt12(val)}</span>` : `<span class="hours-note-inline">${val.join(' – ')}</span>`;
        } else timeEl = `<span class="hours-note-inline">${val}</span>`;
        out += `<div class="hours-row${isToday ? ' today' : ''}">
            <span class="hours-days">${DAY_ABBR[i]}${isToday ? ' <span class="today-tag">today</span>' : ''}</span>
            ${timeEl}
        </div>`;
    });
    if (!hasAnyDay) out = '<span class="hours-note">Hours unavailable</span>';
    if (hours.notes) out += `<span class="hours-note">ℹ️ ${hours.notes}</span>`;
    return out;
}

function fmt12(range) {
    if (!Array.isArray(range) || range.length < 2) return String(range);
    return `${to12(range[0])} – ${to12(range[1])}`;
}
function to12(hhmm) {
    if (!hhmm || typeof hhmm !== 'string' || !hhmm.includes(':')) return hhmm || '';
    let [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function getReviewerName(review) {
    return review.user_name || review.user_email || 'Anonymous';
}

function compareReviewsByVotes(a, b) {
    const scoreA = Number(a.vote_score || 0);
    const scoreB = Number(b.vote_score || 0);
    if (scoreB !== scoreA) return scoreB - scoreA;

    const dateA = new Date(a.created_at || 0).getTime();
    const dateB = new Date(b.created_at || 0).getTime();
    return dateB - dateA;
}

function renderReviewPhotos(review) {
    const photoUrls = review.photo_urls || [];
    const fallbackPhoto = review.photo_url;

    if (photoUrls.length > 1) {
        const photos = photoUrls
            .map((url, idx) => `<img class="rv-review-photo" src="${url}" alt="Review photo ${idx + 1}" style="min-width:100%;width:100%;height:180px;object-fit:cover;display:block;">`)
            .join('');
        return `<div class="review-photo-carousel" data-carousel style="position:relative;margin-top:8px;overflow:hidden;border-radius:10px;">
            <div class="review-photo-track" data-carousel-track data-index="0" style="display:flex;transition:transform .25s ease;">${photos}</div>
            <button type="button" class="review-photo-arrow prev" data-carousel-prev aria-label="Previous photo" style="position:absolute;left:8px;top:50%;transform:translateY(-50%);border:none;border-radius:999px;width:30px;height:30px;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;font-size:16px;line-height:1;">&#8249;</button>
            <button type="button" class="review-photo-arrow next" data-carousel-next aria-label="Next photo" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);border:none;border-radius:999px;width:30px;height:30px;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;font-size:16px;line-height:1;">&#8250;</button>
        </div>`;
    }

    if (photoUrls.length === 1) {
        return `<img class="rv-review-photo" src="${photoUrls[0]}" alt="Review photo" style="width:100%;height:180px;object-fit:cover;display:block;margin-top:8px;border-radius:10px;">`;
    }

    // Fallback to single photo for backward compatibility
    if (fallbackPhoto) {
        return `<img class="rv-review-photo" src="${fallbackPhoto}" alt="Review photo" style="width:100%;height:180px;object-fit:cover;display:block;margin-top:8px;border-radius:10px;">`;
    }

    return '';
}

function attachReviewPhotoCarousels(pane) {
    pane.querySelectorAll('[data-carousel]').forEach(carousel => {
        const track = carousel.querySelector('[data-carousel-track]');
        const prevBtn = carousel.querySelector('[data-carousel-prev]');
        const nextBtn = carousel.querySelector('[data-carousel-next]');
        if (!track || !prevBtn || !nextBtn) return;

        const total = track.children.length;
        if (total <= 1) return;

        const setIndex = (nextIndex) => {
            let idx = nextIndex;
            if (idx < 0) idx = total - 1;
            if (idx >= total) idx = 0;
            track.dataset.index = String(idx);
            track.style.transform = `translateX(-${idx * 100}%)`;
        };

        prevBtn.addEventListener('click', (event) => {
            event.preventDefault();
            const current = Number(track.dataset.index || 0);
            setIndex(current - 1);
        });

        nextBtn.addEventListener('click', (event) => {
            event.preventDefault();
            const current = Number(track.dataset.index || 0);
            setIndex(current + 1);
        });
    });
}

function renderVoteControls(review, loggedIn, currentEmail, featured = false) {
    const reviewId = Number(review.id || 0);
    if (!reviewId) return '';

    const userEmail = (review.user_email || '').toLowerCase();
    const isOwn = Boolean(loggedIn && currentEmail && userEmail === currentEmail);
    const userVote = Number(review.user_vote || 0);
    const voteScore = Number(review.vote_score || 0);
    const rowClass = featured ? 'rv-review-vote-row' : 'review-vote-row';
    const title = isOwn
        ? 'You cannot vote on your own review'
        : (!loggedIn ? 'Sign in to vote on reviews' : 'Vote on this review');

    return `<div class="${rowClass}" data-review-vote-row="${reviewId}">
        <button type="button" class="review-vote-btn js-vote-btn up ${userVote === 1 ? 'active' : ''}" data-review-id="${reviewId}" data-vote="1" ${isOwn ? 'disabled' : ''} title="${title}" aria-label="Upvote review">▲</button>
        <span class="review-vote-score" data-review-score="${reviewId}">${voteScore}</span>
        <button type="button" class="review-vote-btn js-vote-btn down ${userVote === -1 ? 'active' : ''}" data-review-id="${reviewId}" data-vote="-1" ${isOwn ? 'disabled' : ''} title="${title}" aria-label="Downvote review">▼</button>
    </div>`;
}

function attachVoteHandlers(amenity, pane) {
    pane.querySelectorAll('.js-vote-btn').forEach(btn => {
        btn.addEventListener('click', () => submitReviewVote(amenity, pane, btn));
    });
}

function submitReviewVote(amenity, pane, clickedButton) {
    if (!currentUser || !currentUser.is_authenticated) {
        showToast('Please sign in to vote on reviews.', 'warn');
        return;
    }

    const reviewId = Number(clickedButton.dataset.reviewId || 0);
    const requestedVote = Number(clickedButton.dataset.vote || 0);
    if (!reviewId || !requestedVote) return;

    const review = (amenity.reviews || []).find(r => Number(r.id) === reviewId);
    if (!review) {
        showToast('Could not find that review.', 'error');
        return;
    }

    const currentVote = Number(review.user_vote || 0);
    const payloadVote = currentVote === requestedVote ? 'clear' : requestedVote;
    const row = pane.querySelector(`[data-review-vote-row="${reviewId}"]`);
    const buttons = row ? row.querySelectorAll('.js-vote-btn') : [clickedButton];
    buttons.forEach(button => {
        button.disabled = true;
    });

    fetch(`/api/reviews/${reviewId}/vote/`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ vote: payloadVote }),
    })
        .then(r => r.json().then(b => ({ s: r.status, b })).catch(() => ({ s: r.status, b: {} })))
        .then(({ s, b }) => {
            if (s >= 400) {
                showToast(b.error || 'Unable to save vote.', 'error');
                return;
            }

            review.vote_score = Number(b.vote_score || 0);
            review.user_vote = Number(b.user_vote || 0);
            renderReviewsTab(amenity);
        })
        .catch(() => {
            showToast('Network error while saving vote.', 'error');
        })
        .finally(() => {
            buttons.forEach(button => {
                button.disabled = false;
            });
        });
}

function renderReviewerAvatar(review, className = 'rv-avatar') {
    const reviewerName = getReviewerName(review);
    return `<div class="${className}"><img class="reviewer-avatar-image" src="${review.user_avatar_url}" alt="${reviewerName} avatar" onerror="this.onerror=null;this.src='/static/maps/default-avatar.svg';"></div>`;
}

function showToast(msg, type = 'info', duration = 2800) {
    const existing = document.getElementById('map-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.id = 'map-toast';
    const colors = { info: '#1a6ef5', success: '#16a34a', warn: '#d97706', error: '#dc2626' };
    Object.assign(t.style, {
        position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%) translateY(12px)',
        background: colors[type] || colors.info, color: '#fff',
        padding: '10px 18px', borderRadius: '20px', fontSize: '13px', fontWeight: '500',
        fontFamily: "'DM Sans',system-ui,sans-serif", boxShadow: '0 4px 16px rgba(0,0,0,.2)',
        zIndex: '9999', opacity: '0', transition: 'opacity .2s ease, transform .2s ease',
        whiteSpace: 'nowrap', maxWidth: '90vw',
    });
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateX(-50%) translateY(0)'; });
    setTimeout(() => {
        t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(8px)';
        setTimeout(() => t.remove(), 300);
    }, duration);
}

function setupDetailTabs() {
    document.querySelectorAll('.dp-tab').forEach(t => t.addEventListener('click', () => switchDetailTab(t.dataset.tab)));
}

function searchLocations(query) {
    if (query.length < 2) { hideSearchResults(); return; }
    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();
    const params = new URLSearchParams({
        format: 'json', q: query, limit: 6, addressdetails: 1,
    });
    fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal: searchAbortController.signal })
        .then(r => r.json())
        .then(data => {
            const c = document.getElementById('search-results');
            if (!data.length) { positionSearchResults(); c.innerHTML = '<div style="padding:10px 12px;color:var(--text-3);font-size:13px">No results found</div>'; c.classList.add('active'); return; }
            c.innerHTML = data.map(r => {
                const name = r.name || r.address?.road || r.display_name.split(',')[0];
                const sub  = r.display_name.replace(name + ', ', '').split(',').slice(0, 3).join(', ');
                return `<div class="search-result-item" data-lat="${r.lat}" data-lon="${r.lon}">
                    <div class="result-name">${name}</div>
                    <div class="result-address">${sub}</div>
                </div>`;
            }).join('');
            positionSearchResults();
            c.classList.add('active');
            c.querySelectorAll('.search-result-item').forEach(item => {
                item.addEventListener('click', () => {
                    const lat = parseFloat(item.dataset.lat), lon = parseFloat(item.dataset.lon);
                    const name = item.querySelector('.result-name').textContent;
                    map.setView([lat, lon], 16);
                    if (selectedLocationMarker) map.removeLayer(selectedLocationMarker);
                    selectedLocationMarker = L.marker([lat, lon], {
                        title: name, zIndexOffset: 50,
                        icon: L.icon({
                            iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png',
                            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                            iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
                        }),
                    }).addTo(map).bindPopup(name);
                    saveSearchHistory(name, lat, lon);
                    const inp = document.getElementById('search-input');
                    inp.value = name;
                    inp.closest('.search-box').classList.add('has-value');
                    hideSearchResults();
                });
            });
        })
        .catch(e => { if (e.name !== 'AbortError') console.error(e); });
}

function getSearchHistory()   { try { return JSON.parse(localStorage.getItem('mapSearchHistory') || '[]'); } catch { return []; } }
function saveSearchHistory(name, lat, lon) {
    if (!name?.trim()) return;
    const h = getSearchHistory().filter(x => {
        const xName = typeof x === 'string' ? x : x.name;
        return xName.toLowerCase() !== name.toLowerCase();
    });
    localStorage.setItem('mapSearchHistory', JSON.stringify([{ name, lat, lon }, ...h].slice(0, 5)));
}
function showSearchHistory() {
    const h = getSearchHistory(), c = document.getElementById('search-results');
    if (!h.length) { c.classList.remove('active'); return; }
    c.innerHTML = h.map((item, i) => {
        const name = typeof item === 'string' ? item : item.name;
        return `<div class="search-result-item search-history-item" data-index="${i}"><div class="result-name">🕐 ${name}</div></div>`;
    }).join('');
    positionSearchResults();
    c.classList.add('active');
    c.querySelectorAll('.search-history-item').forEach(el => el.addEventListener('click', () => {
        const item = h[parseInt(el.dataset.index, 10)];
        const name = typeof item === 'string' ? item : item.name;
        const inp = document.getElementById('search-input');
        inp.value = name;
        inp.closest('.search-box').classList.add('has-value');
        
        if (item && typeof item === 'object' && item.lat !== undefined && item.lon !== undefined) {
            map.setView([item.lat, item.lon], 16);
            if (selectedLocationMarker) map.removeLayer(selectedLocationMarker);
            selectedLocationMarker = L.marker([item.lat, item.lon], {
                title: name, zIndexOffset: 50,
                icon: L.icon({ iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png', shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] }),
            }).addTo(map).bindPopup(name);
            hideSearchResults();
        } else {
            searchLocations(name);
        }
    }));
}
function positionSearchResults() {
    const inp = document.getElementById('search-input');
    const res = document.getElementById('search-results');
    if (!inp || !res) return;
    const r = inp.getBoundingClientRect();
    res.style.top  = (r.bottom + 4) + 'px';
    res.style.left = r.left + 'px';
    res.style.width = r.width + 'px';
}
function hideSearchResults() { const c = document.getElementById('search-results'); c.classList.remove('active'); c.innerHTML = ''; }

/** Auth Modal UI */
function showAuthModal()  { document.getElementById('auth-modal').style.display = 'flex'; }
function closeAuthModal() {
    document.getElementById('auth-modal').style.display = 'none';
    ['login-error', 'register-error'].forEach(id => { document.getElementById(id).style.display = 'none'; });
}
function switchAuthTab(name) {
    document.querySelectorAll('.auth-tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-tab-link').forEach(l => l.classList.remove('active'));
    document.getElementById(name).classList.add('active');
    document.querySelector(`.auth-tab-link[data-tab="${name}"]`).classList.add('active');
    document.getElementById('auth-modal-title').textContent = name === 'login-tab' ? 'Welcome back' : 'Create account';
}

/** Auth Helpers */
//normalize backend auth payload into one frontend shape.
function normalizeAuthUser(data) {
    if (!data || !data.is_authenticated) return null;
    return {
        id: data.id,
        email: data.email || '',
        username: data.username || '',
        bio: data.bio || '',
        avatar_url: data.avatar_url || '/static/maps/default-avatar.svg',
        is_authenticated: true,
    };
}

//show an inline auth error message in the modal.
function showAuthError(errId, message) {
    const el = document.getElementById(errId);
    if (!el) return;
    el.textContent = message;
    el.style.display = 'block';
}

//clear any previous inline auth error message.
function clearAuthError(errId) {
    const el = document.getElementById(errId);
    if (!el) return;
    el.textContent = '';
    el.style.display = 'none';
}

//ask the server who is logged in for the current session.
function fetchCurrentUser() {
    return fetch('/api/auth/me/', {
        method: 'GET',
        credentials: 'same-origin',
    })
    .then(response => response.json())
    .then(data => {
        currentUser = normalizeAuthUser(data);
        updateUserUI();
        if (pendingAmenityFromQuery) {
            focusAmenityFromQuery(pendingAmenityFromQuery);
            pendingAmenityFromQuery = null;
        }
        return currentUser;
    })
    .catch(error => {
        console.error('Failed to fetch current user:', error);
        currentUser = null;
        updateUserUI();
        return null;
    });
}

/** Auth Actions */
// update in-memory user state and refresh auth UI.
function setCurrentUser(data) {
    currentUser = normalizeAuthUser(data);
    updateUserUI();
    
    // Check for pending messages if user is authenticated
    if (currentUser && currentUser.is_authenticated && typeof checkPendingMessages === 'function') {
        console.log('[Map] User authenticated, checking for pending messages');
        checkPendingMessages();
    }

        // Start SSE stream for new session
        if (currentUser && currentUser.is_authenticated && window.initNotificationsSSE) {
            window.initNotificationsSSE();
        }
}

// submit login/register form data and handle auth errors.
function setupAuthForm(formId, url, errId, isReg = false) {
    document.getElementById(formId).addEventListener('submit', e => {
        e.preventDefault();
        clearAuthError(errId);

        const email = e.target.querySelector('input[type="email"]').value.trim();
        const pass = e.target.querySelector('input[type="password"]').value;

        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ email, password: pass }),
        })
            .then(r => r.json().then(b => ({ s: r.status, b })).catch(() => ({ s: r.status, b: {} })))
            .then(({ s, b }) => {
                if (s >= 400) {
                    showAuthError(errId, b.error || 'Request failed');
                    return;
                }

                if (isReg) {
                    handleLogin(email, pass, errId);
                    return;
                }

                setCurrentUser(b);
                closeAuthModal();
            })
            .catch(() => {
                showAuthError(errId, 'Network error');
                return;
            });
    });
}

// perform email/password login and store returned user state.
function handleLogin(email, pass, errId = 'login-error') {
    clearAuthError(errId);

    return fetch('/api/auth/login/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password: pass }),
    })
        .then(r => r.json().then(b => ({ s: r.status, b })).catch(() => ({ s: r.status, b: {} })))
        .then(({ s, b }) => {
            if (s >= 400) {
                showAuthError(errId, b.error || 'Login failed');
                return null;
            }

            setCurrentUser(b);
            closeAuthModal();
            return b;
        })
        .catch(() => {
            showAuthError(errId, 'Network error');
            return null;
        });
}

// call logout API and clear local in-memory auth state.
function logoutUser() {
    return fetch('/api/auth/logout/', {
        method: 'POST',
        credentials: 'same-origin',
    })
        .then(r => {
            if (r.status >= 400) {
                return fetchCurrentUser();
            }

            currentUser = null;
            updateUserUI();
                
                // Close SSE connection on logout
                if (window.closeNotificationsSSE) {
                    window.closeNotificationsSSE();
                }
            return null;
        })
        .catch(() => {
            return fetchCurrentUser();
        });
}

// Show messaging menu for a reviewer
function showMessagingMenu(userEmail, amenity) {
    if (!currentUser || !currentUser.is_authenticated) {
        showAuthModal();
        return;
    }

    const modal = document.getElementById('messaging-menu-modal');
    document.getElementById('messaging-user-name').textContent = userEmail;

    // Direct message button
    document.getElementById('message-direct-btn').onclick = async () => {
        modal.style.display = 'none';
        try {
            const response = await fetch('/api/chats/direct/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': document.querySelector('[name=csrfmiddlewaretoken]')?.value || getCookie('csrftoken'),
                },
                credentials: 'same-origin',
                body: JSON.stringify({ recipient_email: userEmail }),
            });

            const data = await response.json();
            if (response.ok) {
                window.location.href = `/chats/?chat_id=${data.id}`;
            } else {
                alert('Error: ' + (data.error || 'Could not create chat'));
            }
        } catch (err) {
            console.error('Error creating direct chat:', err);
            alert('Error creating chat');
        }
    };

    // Group chat button (add to group with other reviewers)
    document.getElementById('message-group-btn').onclick = () => {
        modal.style.display = 'none';
        const params = new URLSearchParams({
            new_group: '1',
            amenity_id: amenity.id,
            amenity_name: amenity.prop_name || amenity.name,
            participant: userEmail,
        });
        window.location.href = `/chats/?${params.toString()}`;
    };

    // Profile link
    document.getElementById('view-profile-btn').href = `/profile/?user=${encodeURIComponent(userEmail)}`;

    modal.style.display = 'flex';
    document.getElementById('messaging-menu-close').addEventListener('click', () => {
        modal.style.display = 'none';
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });
}

// render login/logout button and current user label.
function updateUserUI() {
    const btn = document.getElementById('auth-button');
    const userMenu = document.getElementById('user-menu');
    const avatarImage = document.getElementById('avatar-image');
    const userMenuEmail = document.getElementById('user-menu-email');

    if (!btn || !userMenu || !avatarImage || !userMenuEmail) return;

    if (currentUser && currentUser.is_authenticated) {
        btn.style.display = 'none';
        userMenu.style.display = 'inline-flex';
        avatarImage.src = currentUser.avatar_url || '/static/maps/default-avatar.svg';
        userMenuEmail.textContent = currentUser.email || '';
        // Show chats link for authenticated users
        if (typeof ensureChatsLinkVisible === 'function') {
            ensureChatsLinkVisible();
        }
    } else {
        btn.style.display = '';
        userMenu.style.display = 'none';
        userMenuEmail.textContent = '';
        // Hide chats link for unauthenticated users
        if (typeof hideChatsLink === 'function') {
            hideChatsLink();
        }
    }

    if (currentDetailAmenity) {
        renderOverviewTab(currentDetailAmenity);
        wireFavoriteToggle(currentDetailAmenity);
        renderReviewsTab(currentDetailAmenity);
    }
}

function focusAmenityFromQuery(amenityId) {
    const numericAmenityId = Number(amenityId || 0);
    if (!numericAmenityId) return;

    fetch(`/api/amenities/${numericAmenityId}/`, {
        method: 'GET',
        credentials: 'same-origin',
    })
        .then(r => r.json().then(b => ({ s: r.status, b })).catch(() => ({ s: r.status, b: {} })))
        .then(({ s, b }) => {
            if (s >= 400 || !b.amenity) {
                return;
            }

            const amenity = b.amenity;
            map.flyTo([amenity.latitude, amenity.longitude], Math.max(map.getZoom(), 16));

            if (selectedLocationMarker) {
                map.removeLayer(selectedLocationMarker);
            }
            selectedLocationMarker = L.marker([amenity.latitude, amenity.longitude], {
                title: amenity.prop_name || amenity.name,
                zIndexOffset: 50,
                icon: L.icon({
                    iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png',
                    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                    iconSize: [25, 41],
                    iconAnchor: [12, 41],
                    popupAnchor: [1, -34],
                    shadowSize: [41, 41],
                }),
            }).addTo(map);

            updateAmenityFavoriteStateInCache(amenity.id, Boolean(amenity.is_favorited));
            showDetailPanel(amenity);
        })
        .catch(() => {
            // Keep the rest of the map experience working if deep-link focus fails.
        });
}

/** Auth Wiring */
function setupAuth() {
    document.getElementById('auth-button').addEventListener('click', () => currentUser && currentUser.is_authenticated ? logoutUser() : showAuthModal());
    document.getElementById('auth-modal-close').addEventListener('click', closeAuthModal);
    document.getElementById('auth-modal').addEventListener('click', e => { if (e.target.id === 'auth-modal') closeAuthModal(); });
    document.querySelectorAll('.auth-tab-link').forEach(l => l.addEventListener('click', () => switchAuthTab(l.dataset.tab)));
    setupAuthForm('login-form',    '/api/auth/login/',    'login-error');
    setupAuthForm('register-form', '/api/auth/register/', 'register-error', true);
    const avatarButton = document.getElementById('avatar-button');
    const dropdown = document.getElementById('user-menu-dropdown');
    const logoutLink = document.getElementById('logout-link');
    avatarButton.addEventListener('click', () => {
        dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
    });
    logoutLink.addEventListener('click', () => {
        dropdown.style.display = 'none';
        logoutUser();
    });
    document.addEventListener('click', e => {
        if (!dropdown.contains(e.target) && !avatarButton.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
    fetchCurrentUser();
}

function setupPWA() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/maps/sw.js').catch(err => console.error('SW error:', err));
    }

    const promptEl = document.getElementById('pwa-install-prompt');
    const installBtn = document.getElementById('pwa-install-btn');
    const closeBtn = document.getElementById('pwa-close-btn');
    const releaseMeta = document.querySelector('meta[name="app-release"]');
    const appRelease = releaseMeta ? (releaseMeta.getAttribute('content') || '').trim() : '';
    const dismissKey = 'pwa_install_prompt_dismissed_release';
    let deferredPrompt;

    const hidePrompt = () => {
        if (promptEl) promptEl.style.display = 'none';
    };

    const getDismissedRelease = () => {
        try {
            return localStorage.getItem(dismissKey) || '';
        } catch {
            return '';
        }
    };

    const markPromptDismissed = () => {
        if (!appRelease) return;
        try {
            localStorage.setItem(dismissKey, appRelease);
        } catch {
            // Ignore storage failures and keep the prompt ephemeral.
        }
    };

    const isIos = () => /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
    const isInStandaloneMode = () =>
        window.matchMedia('(display-mode: standalone)').matches ||
        (('standalone' in window.navigator) && window.navigator.standalone);

    const shouldShowInstallPrompt = () =>
        Boolean(promptEl) &&
        !isInStandaloneMode() &&
        (!appRelease || getDismissedRelease() !== appRelease);

    const showPrompt = () => {
        if (shouldShowInstallPrompt()) {
            promptEl.style.display = 'block';
        }
    };

    // Handle Android/Chrome automatic prompt
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        if (installBtn) installBtn.style.display = '';
        showPrompt();
    });

    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            hidePrompt();
            const activePrompt = deferredPrompt;
            deferredPrompt = null;
            await activePrompt.prompt();
        });
    }

    // Handle iOS Manual Prompt
    if (isIos() && shouldShowInstallPrompt()) {
        if (promptEl) {
            showPrompt();
            if (installBtn) installBtn.style.display = 'none'; // Hide the button since iOS doesn't support the auto-trigger
            const textEl = promptEl.querySelector('.pwa-prompt-text span');
            if (textEl) textEl.innerHTML = `To install, tap <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin:0 2px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> and <strong>Add to Home Screen</strong>`;
        }
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            markPromptDismissed();
            hidePrompt();
        });
    }

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        hidePrompt();
    });
}

window.addEventListener('beforeunload', () => {
    const mapState = {
        center: map.getCenter(),
        zoom: map.getZoom(),
    };
    if (selectedLocationMarker) {
        mapState.selectedLocation = selectedLocationMarker.getLatLng();
        if (selectedLocationMarker.getPopup()) {
             mapState.selectedLocationName = selectedLocationMarker.getPopup().getContent();
        }
    }
    sessionStorage.setItem('mapState', JSON.stringify(mapState));
});

document.addEventListener('DOMContentLoaded', () => {
    const queryAmenityId = new URLSearchParams(window.location.search).get('amenity_id');

    setupAuth();
    setupSidebarToggle();
    setupHoursFilter();
    setupDetailTabs();
    
    if (restoredState) {
        if (restoredState.selectedLocation) {
            const { lat, lng } = restoredState.selectedLocation;
            const name = restoredState.selectedLocationName || 'Selected Location';
            if (selectedLocationMarker) map.removeLayer(selectedLocationMarker);
            selectedLocationMarker = L.marker([lat, lng], {
                title: name, zIndexOffset: 50,
                icon: L.icon({
                    iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png',
                    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
                }),
            }).addTo(map).bindPopup(name);
            const inp = document.getElementById('search-input');
            if (inp) {
                inp.value = name;
                inp.closest('.search-box').classList.add('has-value');
            }
        }
        initializeGeolocation(false);
    } else {
        initializeGeolocation();
    }

    loadAmenityTypes();
    setupPWA();

    if (queryAmenityId) {
        pendingAmenityFromQuery = queryAmenityId;
    }

    map.addLayer(bikeRackMarkers);
    map.addLayer(otherAmenityMarkers);
    map.on('moveend', loadAmenities);
    map.on('dragstart', () => {
        hoverTooltip.hide();
    });
    map.on('zoomstart', () => {
        hoverTooltip.hide();
    });

    // --- Custom Touch Timer for Mobile Long Press Fallback ---
    let mapTouchTimer;
    let mapTouchPos;

    map.on('touchstart', (e) => {
        if (e.originalEvent.touches && e.originalEvent.touches.length > 1) return;
        mapTouchPos = e.latlng;
        mapTouchTimer = setTimeout(() => {
            map.fire('contextmenu', { latlng: mapTouchPos, originalEvent: e.originalEvent });
        }, 800);
    });

    map.on('touchend', () => clearTimeout(mapTouchTimer));
    map.on('touchmove', () => clearTimeout(mapTouchTimer));

    let contextMenuFired = false;

    // --- Right Click / Long Press to Set Location ---
    map.on('contextmenu', (e) => {
        clearTimeout(mapTouchTimer);
        if (contextMenuFired) return;
        contextMenuFired = true;
        setTimeout(() => contextMenuFired = false, 500); // debounce to avoid double firing on some devices

        if (e.originalEvent && typeof e.originalEvent.preventDefault === 'function') {
            e.originalEvent.preventDefault();
        }
        
        const lat = e.latlng.lat;
        const lon = e.latlng.lng;
        
        showToast('Setting custom location...', 'info', 1000);
        
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`)
            .then(r => r.json())
            .then(data => {
                let name = 'Custom Location';
                if (data && data.display_name) {
                    const parts = [];
                    if (data.name) parts.push(data.name);

                    if (data.address) {
                        if (data.address.road) {
                            const street = data.address.house_number ? `${data.address.house_number} ${data.address.road}` : data.address.road;
                            if (street !== data.name) parts.push(street);
                        }
                        const city = data.address.city || data.address.town || data.address.village || data.address.borough;
                        if (city && !parts.includes(city)) parts.push(city);
                        if (data.address.state && !parts.includes(data.address.state)) parts.push(data.address.state);
                    }

                    if (parts.length === 0) {
                        parts.push(data.display_name.split(',')[0]);
                    }
                    name = parts.join(', ');
                }
                
                updateHomeLocation(lat, lon, name);
                saveSearchHistory(name, lat, lon);
                showToast('Location set to ' + name, 'success');
            })
            .catch(err => {
                console.error('Reverse geocode failed', err);
                updateHomeLocation(lat, lon, 'Custom Location');
                showToast('Custom location set', 'success');
            });
    });

    function updateHomeLocation(lat, lon, name) {
        if (selectedLocationMarker) {
            selectedLocationMarker.setLatLng([lat, lon]).bindPopup(name).openPopup();
            const inp = document.getElementById('search-input');
            if (inp) {
                inp.value = name;
                inp.closest('.search-box').classList.add('has-value');
            }
        } else {
            userLocation = { latitude: lat, longitude: lon };
            if (userMarker) {
                userMarker.setLatLng([lat, lon]).bindPopup('📍 ' + name).openPopup();
            } else {
                userMarker = L.marker([lat, lon], { title: name, zIndexOffset: 100 }).addTo(map).bindPopup('📍 ' + name).openPopup();
            }
            document.getElementById('location-status').textContent = 'Custom location';
            document.getElementById('location-dot').classList.add('found');
        }
    }

    document.getElementById('reset-filters-btn').addEventListener('click', resetAllFilters);
    document.getElementById('location-button').addEventListener('click', retryGeolocation);
    document.getElementById('detail-close-btn').addEventListener('click', () => closeDetailPanel());

    // --- 2-Finger Pinch/Pan on Detail Panel ---
    const dp = document.getElementById('detail-panel');
    let pinchStartDist = 0;
    let pinchStartZoom = 0;
    let pinchCenter = null;
    let pinchStartTouchCenter = null;

    dp.addEventListener('touchstart', e => {
        if (e.touches.length >= 2) {
            e.preventDefault();
            if (!dp.classList.contains('nearby-active')) return;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            pinchStartDist = Math.sqrt(dx * dx + dy * dy);
            pinchStartZoom = map.getZoom();
            
            pinchStartTouchCenter = L.point(
                (e.touches[0].clientX + e.touches[1].clientX) / 2,
                (e.touches[0].clientY + e.touches[1].clientY) / 2
            );
            
            const mapRect = document.getElementById('map').getBoundingClientRect();
            pinchCenter = map.containerPointToLatLng([
                pinchStartTouchCenter.x - mapRect.left, 
                pinchStartTouchCenter.y - mapRect.top
            ]);
        }
    }, { passive: false });

    dp.addEventListener('touchmove', e => {
        if (e.touches.length >= 2) {
            e.preventDefault();
            if (!dp.classList.contains('nearby-active') || pinchStartDist <= 0) return;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            const zoomDelta = Math.log2(dist / pinchStartDist);
            map.setZoomAround(pinchCenter, pinchStartZoom + zoomDelta, { animate: false });
            
            const currentTouchCenter = L.point(
                (e.touches[0].clientX + e.touches[1].clientX) / 2,
                (e.touches[0].clientY + e.touches[1].clientY) / 2
            );
            
            const panX = pinchStartTouchCenter.x - currentTouchCenter.x;
            const panY = pinchStartTouchCenter.y - currentTouchCenter.y;
            
            if (panX !== 0 || panY !== 0) {
                map.panBy([panX, panY], { animate: false });
                pinchStartTouchCenter = currentTouchCenter;
            }
        }
    }, { passive: false });

    dp.addEventListener('touchend', e => {
        if (e.touches.length < 2) {
            pinchStartDist = 0;
        }
    });

    // --- Prevent OS Zoom on Sidebar ---
    const sb = document.getElementById('sidebar');
    if (sb) {
        sb.addEventListener('touchstart', e => { if (e.touches.length >= 2) e.preventDefault(); }, { passive: false });
        sb.addEventListener('touchmove',  e => { if (e.touches.length >= 2) e.preventDefault(); }, { passive: false });
    }

    map.on('click', (e) => {
        // If the click is on a marker, do nothing.
        if (e.originalEvent.target.closest('.amenity-marker-icon')) {
            return;
        }

        const isMobile = window.innerWidth <= 768;
        const wasOpen = document.getElementById('detail-panel').classList.contains('open');
        const lastAmenity = currentDetailAmenity;

        if (isMobile && wasOpen && lastAmenity) {
            closeDetailPanel(true);
            const pt = map.latLngToContainerPoint([lastAmenity.latitude, lastAmenity.longitude]);
            const rect = document.getElementById('map').getBoundingClientRect();
            hoverTooltip.show(lastAmenity, rect.left + pt.x, rect.top + pt.y);
        } else {
            closeDetailPanel();
            hoverTooltip.hide();
        }

        if (window.innerWidth <= 768) {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar.classList.contains('collapsed')) {
                sidebar.classList.add('collapsed');
                document.getElementById('sidebar-open-btn').style.display = 'flex';
                document.body.classList.remove('sidebar-open');
            }
        }
    });

    document.getElementById('include-inactive').addEventListener('change', loadAmenities);
    document.getElementById('only-accessible').addEventListener('change', loadAmenities);

    const si  = document.getElementById('search-input');
    const sc  = document.getElementById('search-clear');
    const box = si.closest('.search-box');
    const syncClear = () => box.classList.toggle('has-value', si.value.length > 0);

    si.addEventListener('focus', () => { if (!si.value) showSearchHistory(); });
    si.addEventListener('input', e => {
        clearTimeout(searchTimeout);
        syncClear();
        if (!e.target.value) { showSearchHistory(); return; }
        searchTimeout = setTimeout(() => searchLocations(e.target.value), 300);
    });
    sc.addEventListener('click', () => {
        si.value = '';
        syncClear();
        if (selectedLocationMarker) { map.removeLayer(selectedLocationMarker); selectedLocationMarker = null; }
        hideSearchResults();
        si.focus();
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('.search-box') && !e.target.closest('.search-results')) hideSearchResults();
    });

    if (location.hash) {
        const parts = location.hash.slice(1).split(',');
        if (parts.length >= 2) { const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]); if (!isNaN(lat) && !isNaN(lng)) map.setView([lat, lng], 17); }
    }
});
