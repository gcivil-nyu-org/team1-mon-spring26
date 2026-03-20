const map = L.map('map', { renderer: L.canvas(), zoomControl: false, zoomSnap: 0 }).setView([40.73, -73.99], 13);

const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const tileUrl = isLocalhost ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' : '/tiles/{z}/{x}/{y}.png';
L.tileLayer(tileUrl, {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
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

const hoursFilter = {
    openNow:      false,
    selectedDays: new Set([new Date().getDay()]),
    fromMinutes:  0,
    toMinutes:    1439,
};

function initializeGeolocation() {
    const statusEl = document.getElementById('location-status');
    const dotEl    = document.getElementById('location-dot');
    const locBtn   = document.getElementById('location-button');
    if (!navigator.geolocation) { statusEl.textContent = 'Not supported'; return; }
    locBtn.classList.add('locating');
    statusEl.textContent = 'Locating…';
    const tid = setTimeout(() => {
        if (!userLocation) { statusEl.textContent = 'Default location'; locBtn.classList.remove('locating'); map.setView([40.73, -73.99], 13); }
    }, 8000);
    navigator.geolocation.getCurrentPosition(
        ({ coords: { latitude, longitude } }) => {
            clearTimeout(tid);
            userLocation = { latitude, longitude };
            map.setView([latitude, longitude], 15);
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
            statusEl.textContent = ({ 1: 'Permission denied', 2: 'Unavailable', 3: 'Timed out' })[err.code] || 'Unable to locate';
            map.setView([40.73, -73.99], 13);
        },
        { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }
    );
}

function retryGeolocation() {
    userLocation = null;
    document.getElementById('location-dot').classList.remove('found', 'denied');
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
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

    function collapse() {
        sidebar.classList.add('collapsed');
        openBtn.style.display = 'flex';
        body.classList.remove('sidebar-open');
    }

    function expand() {
        sidebar.classList.remove('collapsed');
        openBtn.style.display = 'none';
        body.classList.add('sidebar-open');
        if (window.innerWidth <= 768) {
            closeDetailPanel();
        }
    }

    document.getElementById('sidebar-toggle').addEventListener('click', collapse);
    openBtn.addEventListener('click', expand);

    // Default state based on screen size
    if (window.innerWidth <= 768) {
        collapse();
    } else {
        expand();
    }
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

    const refLat = userLocation ? userLocation.latitude  : map.getCenter().lat;
    const refLon = userLocation ? userLocation.longitude : map.getCenter().lng;
    const mi = haversineKm(refLat, refLon, a.latitude, a.longitude) * 0.621371;
    const distStr = mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(2)} mi`;
    const distLabel2 = userLocation ? 'Distance' : 'From center';
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
    const svgPaths = {
        droplet:   '<path d="M12 0C8 8,2 14,2 19C2 26.7,6.5 32,12 32C17.5 32,22 26.7,22 19C22 14,16 8,12 0Z"/>',
        restroom:  '<path d="M4,8C4,6.34 5.34,5 7,5C8.66,5 10,6.34 10,8C10,9.66 8.66,11 7,11C5.34,11 4,9.66 4,8M17,5C15.34,5 14,6.34 14,8C14,9.66 15.34,11 17,11C18.66,11 20,9.66 20,8C20,6.34 18.66,5 17,5M12,13L12,30L16,30L16,20L18,20L18,30L22,30L22,13L12,13M2,13L2,30L6,30L6,20L8,20L8,30L12,30L12,13L2,13Z"/>',
        bicycle:   '<path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>',
        snowflake: '<path d="M12 2.5l-2.5 4.33h5L12 2.5zm0 19l-2.5-4.33h5L12 21.5zM4.33 7.5L2.5 12l1.83 4.5h4.34L4.33 7.5zm15.34 0L15.33 12l1.83 4.5h4.34L19.67 7.5zM8.67 16.5L12 10l3.33 6.5H8.67zm0-9L12 14l3.33-6.5H8.67z" transform="scale(1.2) translate(-2,-2)"/>',
        // wifi signal bars for LinkNYC Kiosk
        wifi:      '<path d="M12 4C7.6 4 3.6 5.8 0.7 8.7L3.5 11.5C5.7 9.3 8.7 8 12 8C15.3 8 18.3 9.3 20.5 11.5L23.3 8.7C20.4 5.8 16.4 4 12 4ZM12 12C9.8 12 7.8 12.9 6.3 14.4L9.1 17.2C9.9 16.4 11 16 12 16C13 16 14.1 16.4 14.9 17.2L17.7 14.4C16.2 12.9 14.2 12 12 12ZM12 20C10.9 20 10 20.9 10 22C10 23.1 10.9 24 12 24C13.1 24 14 23.1 14 22C14 20.9 13.1 20 12 20Z"/>',
        default:   '<path d="M12 0C8 8,2 14,2 19C2 26.7,6.5 32,12 32C17.5 32,22 26.7,22 19C22 14,16 8,12 0Z"/>',
    };
    const icon = L.divIcon({
        html: `<div style="width:24px;height:32px;filter:${filt}">
            <svg viewBox="0 0 24 32" width="24" height="32" xmlns="http://www.w3.org/2000/svg">
                <defs><style>.p${amenity.id}{fill:${amenity.color};stroke:rgba(0,0,0,.22);stroke-width:.5}</style></defs>
                <g class="p${amenity.id}">${svgPaths[amenity.icon] || svgPaths.default}</g>
            </svg></div>`,
        iconSize: [24, 32], iconAnchor: [12, 32], popupAnchor: [0, -32], className: 'leaflet-div-icon-custom amenity-marker-icon',
    });

    const marker = L.marker([amenity.latitude, amenity.longitude], { icon, amenityData: amenity });
    marker.on('mouseover', e => { clearTimeout(hoverTooltipTimer); hoverTooltip.show(amenity, e.originalEvent.clientX, e.originalEvent.clientY); });
    marker.on('mousemove', e => hoverTooltip.move(e.originalEvent.clientX, e.originalEvent.clientY));
    marker.on('mouseout',  () => { hoverTooltipTimer = setTimeout(() => hoverTooltip.hide(), 80); });
    marker.on('click', e => {
        hoverTooltip.hide();
        showDetailPanel(amenity); 
    });

    if (amenity.type === 'Bike Rack' || amenity.type.includes('Bike Rack')) bikeRackMarkers.addLayer(marker);
    else otherAmenityMarkers.addLayer(marker);
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distLabel(fromLat, fromLon, toLat, toLon) {
    const mi = haversineKm(fromLat, fromLon, toLat, toLon) * 0.621371;
    return mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(2)} mi`;
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
    let html = '';

    html += `<div class="dp-section"><span class="dp-status ${amenity.active ? 'active' : 'inactive'}">${amenity.active ? 'Active' : 'Inactive'}</span></div>`;

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

    const walkUrl  = `https://www.google.com/maps/dir/?api=1&destination=${amenity.latitude},${amenity.longitude}&travelmode=walking`;
    const bikeUrl  = `https://www.google.com/maps/dir/?api=1&destination=${amenity.latitude},${amenity.longitude}&travelmode=bicycling`;
    html += `<div class="dp-section"><div class="dp-nav">
        <a href="${walkUrl}" target="_blank" class="dp-nav-btn">🚶 Walk there</a>
        <a href="${bikeUrl}" target="_blank" class="dp-nav-btn">🚴 Bike there</a>
    </div></div>`;

    document.getElementById('tab-overview').innerHTML = html;
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
        html += `<span class="rv-rating-big">${avg.toFixed(1)}</span>
            <div class="rv-rating-right">
                <div class="rv-stars">${stars}</div>
                <div class="rv-count">${amenity.review_count} review${amenity.review_count !== 1 ? 's' : ''}</div>
            </div>`;
    } else {
        html += `<span class="rv-rating-big" style="font-size:26px">-</span>
            <div class="rv-rating-right">
                <div class="rv-stars">☆☆☆☆☆</div>
                <div class="rv-count">No ratings yet</div>
            </div>`;
    }
    html += `</div></div>`;

    const reviews = amenity.reviews || [];
    const loggedIn = currentUser && currentUser.is_authenticated;
    const currentEmail = (currentUser?.email || '').toLowerCase();
    const alreadyReviewed = loggedIn && reviews.some(r => (r.user_name || '').toLowerCase() === currentEmail);

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
            <input type="file" class="js-review-photo" accept="image/*" style="margin-top:8px;font-size:12px;color:var(--text-2)">
            <div style="display:flex;justify-content:flex-end">
                <button type="button" class="review-submit js-review-submit">Submit Review</button>
            </div>
        </div>`;
    }

    if (reviews.length) {
        const byRecent = [...reviews].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const top  = [...reviews].sort((a, b) => (b.rating - a.rating) || (new Date(b.created_at) - new Date(a.created_at)))[0];
        const stars = '★'.repeat(top.rating) + '☆'.repeat(5 - top.rating);
        const date  = new Date(top.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        const initial = (top.user_name || '?').charAt(0).toUpperCase();
        html += `<div class="dp-section">
            <div class="dp-field-label">Most Popular Review</div>
            <div class="rv-review-card">
                <div class="rv-review-header">
                    <div class="rv-avatar">${initial}</div>
                    <div class="rv-review-meta">
                        <div class="rv-reviewer">${top.user_name}</div>
                        <div class="rv-review-stars">${stars}</div>
                    </div>
                    <div class="rv-review-date">${date}</div>
                </div>
                <div class="rv-review-text">${top.review_text || 'No written comment.'}</div>
                ${top.photo_url ? `<img class="rv-review-photo" src="${top.photo_url}" alt="Review photo">` : ''}
            </div>
        </div>`;

        const otherReviews = byRecent.filter(r => r !== top);
        if (otherReviews.length) {
            html += `<div class="dp-section">
                <div class="dp-field-label">Recent Reviews</div>
                <div class="review-list">${otherReviews.map(r => {
                    const rStars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
                    const rDate = new Date(r.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
                    return `<div class="review-card">
                        <div class="review-card-top">
                            <div class="review-user">${r.user_name}</div>
                            <div class="review-date">${rDate}</div>
                        </div>
                        <div class="review-stars">${rStars}</div>
                        <div class="review-text">${r.review_text || 'No written comment.'}</div>
                        ${r.photo_url ? `<img class="review-photo" src="${r.photo_url}" alt="Review photo">` : ''}
                    </div>`;
                }).join('')}</div>
            </div>`;
        }
    } else {
        html += `<div class="dp-section"><div class="rv-empty">No reviews yet for this location.<br>Be the first to share your experience!</div></div>`;
    }

    pane.innerHTML = html;

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
}

function submitReview(amenity, pane) {
    if (!currentUser || !currentUser.is_authenticated) {
        showToast('Please sign in to add a review.', 'warn');
        return;
    }

    const textEl = pane.querySelector('.js-review-text');
    const starPicker = pane.querySelector('.js-star-picker');
    const photoEl = pane.querySelector('.js-review-photo');
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
    if (photoEl && photoEl.files && photoEl.files[0]) formData.append('photo', photoEl.files[0]);

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
                user_name: b.user_name || currentUser.email || currentUser.username || 'You',
                rating: b.rating || rating,
                review_text: b.review_text || reviewText,
                photo_url: b.photo_url || null,
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
                    saveSearchHistory(name);
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
function saveSearchHistory(q) {
    if (!q?.trim()) return;
    const h = getSearchHistory().filter(x => x.toLowerCase() !== q.toLowerCase());
    localStorage.setItem('mapSearchHistory', JSON.stringify([q, ...h].slice(0, 5)));
}
function showSearchHistory() {
    const h = getSearchHistory(), c = document.getElementById('search-results');
    if (!h.length) { c.classList.remove('active'); return; }
    c.innerHTML = h.map(s => `<div class="search-result-item search-history-item" data-search="${s}"><div class="result-name">🕐 ${s}</div></div>`).join('');
    positionSearchResults();
    c.classList.add('active');
    c.querySelectorAll('.search-history-item').forEach(el => el.addEventListener('click', () => {
        const inp = document.getElementById('search-input');
        inp.value = el.dataset.search;
        inp.closest('.search-box').classList.add('has-value');
        searchLocations(el.dataset.search);
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
            return null;
        })
        .catch(() => {
            return fetchCurrentUser();
        });
}

// render login/logout button and current user label.
function updateUserUI() {
    const btn = document.getElementById('auth-button');
    const disp = document.getElementById('user-display');

    if (!btn || !disp) return;

    if (currentUser && currentUser.is_authenticated) {
        disp.textContent = currentUser.username || currentUser.email;
        disp.style.display = '';
        btn.textContent = 'Logout';
    } else {
        disp.textContent = '';
        disp.style.display = 'none';
        btn.textContent = 'Login';
    }

    if (currentDetailAmenity) renderReviewsTab(currentDetailAmenity);
}

/** Auth Wiring */
function setupAuth() {
    document.getElementById('auth-button').addEventListener('click', () => currentUser && currentUser.is_authenticated ? logoutUser() : showAuthModal());
    document.getElementById('auth-modal-close').addEventListener('click', closeAuthModal);
    document.getElementById('auth-modal').addEventListener('click', e => { if (e.target.id === 'auth-modal') closeAuthModal(); });
    document.querySelectorAll('.auth-tab-link').forEach(l => l.addEventListener('click', () => switchAuthTab(l.dataset.tab)));
    setupAuthForm('login-form',    '/api/auth/login/',    'login-error');
    setupAuthForm('register-form', '/api/auth/register/', 'register-error', true);
    fetchCurrentUser();
}

function setupPWA() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/maps/sw.js').catch(err => console.error('SW error:', err));
    }

    const promptEl = document.getElementById('pwa-install-prompt');
    const installBtn = document.getElementById('pwa-install-btn');
    const closeBtn = document.getElementById('pwa-close-btn');
    let deferredPrompt;

    // Handle Android/Chrome automatic prompt
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        if (promptEl) promptEl.style.display = 'block';
    });

    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            promptEl.style.display = 'none';
            deferredPrompt.prompt();
            deferredPrompt = null;
        });
    }

    // Handle iOS Manual Prompt
    const isIos = () => /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
    const isInStandaloneMode = () => ('standalone' in window.navigator) && (window.navigator.standalone);

    if (isIos() && !isInStandaloneMode()) {
        if (promptEl) {
            promptEl.style.display = 'block';
            if (installBtn) installBtn.style.display = 'none'; // Hide the button since iOS doesn't support the auto-trigger
            const textEl = promptEl.querySelector('.pwa-prompt-text span');
            if (textEl) textEl.innerHTML = `To install, tap <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin:0 2px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> and <strong>Add to Home Screen</strong>`;
        }
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => { if (promptEl) promptEl.style.display = 'none'; });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    setupAuth();
    setupSidebarToggle();
    setupHoursFilter();
    setupDetailTabs();
    initializeGeolocation();
    loadAmenityTypes();
    loadAmenities();
    setupPWA();

    map.addLayer(bikeRackMarkers);
    map.addLayer(otherAmenityMarkers);
    map.on('moveend', loadAmenities);
    map.on('dragstart', () => hoverTooltip.hide());
    map.on('zoomstart', () => hoverTooltip.hide());

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
        if (e.touches.length === 2 && dp.classList.contains('nearby-active')) {
            e.preventDefault();
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
        if (e.touches.length === 2 && dp.classList.contains('nearby-active') && pinchStartDist > 0) {
            e.preventDefault();
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