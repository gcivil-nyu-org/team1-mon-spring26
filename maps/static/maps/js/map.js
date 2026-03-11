
// create the map and set default view

const map = L.map('map').setView([40.7580, -73.9855], 13);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
}).addTo(map);

const state = {
    amenities: [],
    types: [],
    selectedTypeId: '',
    amenityLayer: L.layerGroup().addTo(map),
    searchMarker: null,
    userLocationMarker: null,
    searchAbortController: null,
    searchDebounceTimer: null,
};

const els = {
    searchInput: document.getElementById('search-input'),
    searchButton: document.getElementById('search-button'),
    searchResults: document.getElementById('search-results'),
    typeFilter: document.getElementById('type-filter'),
    locationButton: document.getElementById('location-button'),
    locationStatus: document.getElementById('location-status'),
};

function setLocationStatus(msg) {
    if (els.locationStatus) els.locationStatus.textContent = msg || '';
}

function debounce(fn, wait = 350) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

const onSearchInput = debounce(() => {
    runSearch(els.searchInput.value.trim());
}, 350);

els.searchInput.addEventListener('input', onSearchInput);
els.searchButton.addEventListener('click', () => {
    runSearch(els.searchInput.value.trim());
});
els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch(els.searchInput.value.trim());
});

function cancelPreviousSearch() {
    if (state.searchAbortController) {
        state.searchAbortController.abort();
    }
    state.searchAbortController = new AbortController();
    return state.searchAbortController.signal;
}

async function runSearch(query) {
    if (!query || query.length < 2) {
        els.searchResults.innerHTML = '';
        return;
    }

    const signal = cancelPreviousSearch();
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`;

    try {
        const resp = await fetch(url, { signal, headers: { 'Accept-Language': 'en' } });
        if (!resp.ok) throw new Error(`Search failed: HTTP ${resp.status}`);
        const results = await resp.json();
        renderSearchResults(results);
    } catch (err) {
        if (err.name === 'AbortError') return;
        console.error(err);
        els.searchResults.innerHTML = '<li><button type="button">Search failed</button></li>';
    }
}

function renderSearchResults(results) {
    if (!Array.isArray(results) || results.length === 0) {
        els.searchResults.innerHTML = '<li><button type="button">No results</button></li>';
        return;
    }

    els.searchResults.innerHTML = results.map((r, idx) => (
        `<li><button type="button" data-idx="${idx}">${r.display_name}</button></li>`
    )).join('');

    els.searchResults.querySelectorAll('button[data-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const r = results[Number(btn.dataset.idx)];
            focusSearchResult(r);
        });
    });
}

function focusSearchResult(result) {
    const lat = Number(result.lat);
    const lon = Number(result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    map.setView([lat, lon], 15);

    if (state.searchMarker) {
        state.searchMarker.setLatLng([lat, lon]);
    } else {
        state.searchMarker = L.marker([lat, lon]).addTo(map);
    }
    state.searchMarker.bindPopup(result.display_name || 'Search Result').openPopup();
}