document.addEventListener('DOMContentLoaded', () => {
    const pageRoot = document.getElementById('profile-page-root');
    if (!pageRoot) return;

    const state = {
        reviews: [],
        reviewsLoaded: false,
        favorites: [],
        favoritesLoaded: false,
        activeReviewId: null,
        reviewSheetMode: 'view',
    };

    const dropdown = document.getElementById('user-menu-dropdown');
    const dropdownToggle = document.getElementById('avatar-button');
    const logoutButton = document.getElementById('logout-link');
    const tabRail = document.querySelector('.profile-tab-rail');
    const tabButtons = Array.from(document.querySelectorAll('.profile-tab-button'));
    const tabPanels = Array.from(document.querySelectorAll('.profile-tab-panel'));
    const tabIndicator = document.getElementById('profile-tab-indicator');

    const reviewsState = document.getElementById('profile-reviews-state');
    const reviewsList = document.getElementById('profile-reviews-list');
    const favoritesState = document.getElementById('profile-favorites-state');
    const favoritesList = document.getElementById('profile-favorites-list');

    const reviewSheet = document.getElementById('review-sheet');
    const reviewSheetPanel = document.getElementById('review-sheet-panel');
    const reviewSheetHeaderCopy = document.getElementById('review-sheet-header-copy');
    const reviewSheetBody = document.getElementById('review-sheet-body');
    const reviewSheetClose = document.getElementById('review-sheet-close');
    const reviewSheetBackdrop = document.getElementById('review-sheet-backdrop');
    let reviewSheetHideTimer = null;

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function formatDate(isoString) {
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) return '';

        return new Intl.DateTimeFormat('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        }).format(date);
    }

    function positionTabIndicator(activeButton) {
        if (!tabRail || !tabIndicator || !activeButton) return;

        const railRect = tabRail.getBoundingClientRect();
        const buttonRect = activeButton.getBoundingClientRect();
        tabIndicator.style.width = `${Math.round(buttonRect.width)}px`;
        tabIndicator.style.transform = `translateX(${Math.round(buttonRect.left - railRect.left)}px)`;
    }

    function setActiveTab(tabName) {
        let activeButton = null;

        tabButtons.forEach(button => {
            const isActive = button.dataset.tab === tabName;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', String(isActive));
            if (isActive) activeButton = button;
        });

        tabPanels.forEach(panel => {
            panel.classList.toggle('is-active', panel.dataset.panel === tabName);
        });

        positionTabIndicator(activeButton);

        if (tabName === 'reviews' && !state.reviewsLoaded) {
            fetchProfileReviews();
        }

        if (tabName === 'favorites' && !state.favoritesLoaded) {
            fetchProfileFavorites();
        }
    }

    function setupTabs() {
        if (!tabButtons.length) return;

        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                setActiveTab(button.dataset.tab);
            });
        });

        window.addEventListener('resize', () => {
            const activeButton = tabButtons.find(button => button.classList.contains('is-active'));
            positionTabIndicator(activeButton);
        });
    }

    function setupDropdown() {
        if (!dropdown || !dropdownToggle) return;

        dropdownToggle.addEventListener('click', event => {
            event.stopPropagation();
            const shouldOpen = dropdown.style.display !== 'block';
            dropdown.style.display = shouldOpen ? 'block' : 'none';
        });

        document.addEventListener('click', event => {
            if (!dropdown.contains(event.target) && !dropdownToggle.contains(event.target)) {
                dropdown.style.display = 'none';
            }
        });
    }

    function setupLogout() {
        if (!logoutButton) return;

        logoutButton.addEventListener('click', async () => {
            try {
                await fetch(pageRoot.dataset.logoutUrl, {
                    method: 'POST',
                    credentials: 'same-origin',
                });

                window.location.href = '/';
            } catch (error) {
                window.alert('Unable to log out right now.');
            }
        });
    }

    function renderDisplayStars(rating) {
        const score = Math.min(5, Math.max(0, Number(rating || 0) || 0));
        return [1, 2, 3, 4, 5]
            .map(value => `
                <span class="profile-display-star ${value <= score ? 'is-lit' : ''}" aria-hidden="true">★</span>
            `)
            .join('');
    }

    function renderStarPicker(rating) {
        const score = Math.min(5, Math.max(1, Number(rating || 5) || 5));
        const stars = [1, 2, 3, 4, 5]
            .map(value => `
                <button
                    type="button"
                    class="star-btn js-sheet-star ${value <= score ? 'lit' : ''}"
                    data-value="${value}"
                    aria-label="Rate ${value} star${value === 1 ? '' : 's'}"
                >★</button>
            `)
            .join('');

        return `
            <div class="star-picker js-sheet-star-picker" data-rating="${score}" role="radiogroup" aria-label="Review rating">
                ${stars}
            </div>
        `;
    }

    function renderAmenityTypeBadge(review) {
        const label = String(review.amenity_type || '').trim();
        if (!label) return '';

        return `
            <div class="profile-review-type-row">
                <span class="dp-badge">${escapeHtml(label)}</span>
            </div>
        `;
    }

    function renderCurrentUserRow(showMenu = true) {
        const reviewerName = String(pageRoot.dataset.currentUserName || '').trim() || 'You';
        const avatarUrl = String(pageRoot.dataset.currentUserAvatar || '').trim();

        return `
            <div class="profile-review-sheet-reviewer-shell">
                <div class="review-reviewer-row profile-review-sheet-reviewer-row">
                    <div class="rv-avatar">
                        ${avatarUrl
                            ? `<img class="reviewer-avatar-image" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(reviewerName)} avatar" onerror="this.onerror=null;this.src='/static/maps/default-avatar.svg';">`
                            : 'U'}
                    </div>
                    <div class="rv-reviewer">${escapeHtml(reviewerName)}</div>
                </div>

                ${showMenu ? `
                    <div id="review-sheet-menu-wrap" class="profile-review-sheet-menu">
                        <button
                            id="review-sheet-menu-button"
                            class="profile-review-sheet-menu-button"
                            type="button"
                            aria-label="Review actions"
                            aria-haspopup="menu"
                            aria-expanded="false"
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <circle cx="12" cy="5" r="1.8"></circle>
                                <circle cx="12" cy="12" r="1.8"></circle>
                                <circle cx="12" cy="19" r="1.8"></circle>
                            </svg>
                        </button>
                        <div id="review-sheet-menu-dropdown" class="profile-review-sheet-menu-dropdown" hidden>
                            <button type="button" class="profile-review-sheet-menu-item js-sheet-header-edit">Edit</button>
                            <button type="button" class="profile-review-sheet-menu-item is-danger js-sheet-header-delete">Delete</button>
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    function getReviewSheetMenuElements() {
        if (!reviewSheet) {
            return {
                wrap: null,
                button: null,
                dropdown: null,
            };
        }

        return {
            wrap: reviewSheet.querySelector('#review-sheet-menu-wrap'),
            button: reviewSheet.querySelector('#review-sheet-menu-button'),
            dropdown: reviewSheet.querySelector('#review-sheet-menu-dropdown'),
        };
    }

    function renderReviewCard(review) {
        const amenityDisplayName = review.amenity_prop_name || review.amenity_name || 'Amenity';

        return `
            <article
                class="profile-review-card profile-review-card-clickable"
                data-review-id="${review.id}"
                tabindex="0"
                role="button"
                aria-label="Open review for ${escapeHtml(amenityDisplayName)}"
            >
                <div class="profile-review-card-top">
                    <div>
                        <div class="profile-review-place">${escapeHtml(amenityDisplayName)}</div>
                        ${renderAmenityTypeBadge(review)}
                    </div>
                </div>

                <div class="profile-review-rating-row">
                    <div class="profile-review-stars" aria-label="Rated ${escapeHtml(String(review.rating))} out of 5">
                        ${renderDisplayStars(review.rating)}
                    </div>
                    <span class="profile-review-date">${escapeHtml(formatDate(review.updated_at || review.created_at))}</span>
                </div>

                <p class="profile-review-text">${escapeHtml(review.review_text || 'No written comment.')}</p>

                ${review.photo_url ? `
                    <img class="profile-review-photo" src="${escapeHtml(review.photo_url)}" alt="Review photo">
                ` : ''}
            </article>
        `;
    }

    function renderReviews() {
        if (!reviewsState || !reviewsList) return;

        if (!state.reviews.length) {
            reviewsState.hidden = false;
            reviewsState.innerHTML = `
                <div class="profile-empty-title">You haven't written any reviews yet.</div>
                <p class="profile-empty-copy">Your reviews will appear here once you start sharing feedback.</p>
            `;
            reviewsList.hidden = true;
            reviewsList.innerHTML = '';
            return;
        }

        reviewsState.hidden = true;
        reviewsList.hidden = false;
        reviewsList.innerHTML = state.reviews.map(renderReviewCard).join('');
    }

    function buildFavoriteMapUrl(favorite) {
        const mapUrl = String(pageRoot.dataset.mapUrl || '/').trim() || '/';
        const url = new URL(mapUrl, window.location.origin);
        url.searchParams.set('amenity_id', String(favorite.amenity_id));
        return `${url.pathname}${url.search}`;
    }

    function renderFavoriteCard(favorite) {
        const amenityDisplayName = favorite.amenity_prop_name || favorite.amenity_name || 'Amenity';
        const address = String(favorite.address || '').trim();

        return `
            <article class="profile-review-card">
                <div class="profile-review-card-top">
                    <div>
                        <div class="profile-review-place">${escapeHtml(amenityDisplayName)}</div>
                        <div class="profile-review-type-row">
                            <span class="dp-badge">${escapeHtml(favorite.amenity_type || 'Amenity')}</span>
                        </div>
                    </div>
                </div>

                ${address ? `<p class="profile-review-text">${escapeHtml(address)}</p>` : ''}

                <a class="profile-empty-link" href="${escapeHtml(buildFavoriteMapUrl(favorite))}">
                    View on map
                </a>
            </article>
        `;
    }

    function renderFavorites() {
        if (!favoritesState || !favoritesList) return;

        if (!state.favorites.length) {
            favoritesState.hidden = false;
            favoritesState.innerHTML = `
                <div class="profile-empty-title">No favorites yet.</div>
                <p class="profile-empty-copy">Save places from the map and they will appear here.</p>
            `;
            favoritesList.hidden = true;
            favoritesList.innerHTML = '';
            return;
        }

        favoritesState.hidden = true;
        favoritesList.hidden = false;
        favoritesList.innerHTML = state.favorites.map(renderFavoriteCard).join('');
    }

    function getActiveReview() {
        if (!state.activeReviewId) return null;

        return state.reviews.find(item => item.id === state.activeReviewId) || null;
    }

    function hasPendingReviewChanges() {
        const review = getActiveReview();
        const form = document.getElementById('review-sheet-edit-form');
        if (!review || !form) return false;

        const starPicker = form.querySelector('.js-sheet-star-picker');
        const textInput = form.querySelector('.js-sheet-review-text');
        if (!starPicker || !textInput) return false;

        const rating = Math.min(5, Math.max(1, parseInt(starPicker.dataset.rating || '5', 10) || 5));
        const reviewText = textInput.value.trim();

        return rating !== Number(review.rating || 0) || reviewText !== String(review.review_text || '');
    }

    function syncReviewSheetSaveState() {
        const saveButton = reviewSheetBody ? reviewSheetBody.querySelector('.js-sheet-save') : null;
        if (!saveButton) return;

        saveButton.disabled = !hasPendingReviewChanges();
    }

    function setReviewSheetMenuOpen(isOpen) {
        const { wrap, button, dropdown } = getReviewSheetMenuElements();
        if (!wrap || !button || !dropdown || wrap.hidden) return;

        dropdown.hidden = !isOpen;
        button.setAttribute('aria-expanded', String(isOpen));
        wrap.classList.toggle('is-open', isOpen);
    }

    function setReviewSheetMenuVisible(isVisible) {
        const { wrap } = getReviewSheetMenuElements();
        if (!wrap) return;

        wrap.hidden = !isVisible;
        if (!isVisible) {
            setReviewSheetMenuOpen(false);
        }
    }

    function renderReviewSheet() {
        if (!reviewSheet || !reviewSheetBody || !reviewSheetHeaderCopy || !state.activeReviewId) return;

        const review = getActiveReview();
        if (!review) {
            closeReviewSheet();
            return;
        }

        const isEditMode = state.reviewSheetMode === 'edit';
        const isDeleteMode = state.reviewSheetMode === 'confirm_delete';
        const reviewText = review.review_text || 'No written comment.';
        const reviewDate = formatDate(review.updated_at || review.created_at);
        const amenityDisplayName = review.amenity_prop_name || review.amenity_name || 'Amenity';

        if (isDeleteMode) {
            setReviewSheetMenuVisible(false);
            reviewSheetHeaderCopy.innerHTML = `
                <h2 class="profile-review-sheet-title" id="review-sheet-title">${escapeHtml(amenityDisplayName)}</h2>
                ${renderAmenityTypeBadge(review)}
            `;

            reviewSheetBody.innerHTML = `
                <section class="profile-review-sheet-section profile-review-sheet-section-plain profile-review-sheet-section-tight">
                    <div class="profile-review-sheet-delete-copy">
                        <p class="profile-review-sheet-copy profile-review-sheet-copy-delete">
                            Delete this review?
                        </p>

                        <p class="profile-review-sheet-copy profile-review-sheet-copy-subtle">
                            This action cannot be undone.
                        </p>
                    </div>
                </section>

                <section class="profile-review-sheet-section profile-review-sheet-section-plain profile-review-sheet-actions">
                    <button type="button" class="profile-review-sheet-secondary js-sheet-cancel-delete">Cancel</button>
                    <button type="button" class="profile-review-sheet-danger js-sheet-confirm-delete">Delete</button>
                </section>
            `;
            return;
        }

        if (!isEditMode) {
            setReviewSheetMenuVisible(true);
            reviewSheetHeaderCopy.innerHTML = `
                <h2 class="profile-review-sheet-title" id="review-sheet-title">${escapeHtml(amenityDisplayName)}</h2>
                ${renderAmenityTypeBadge(review)}
            `;

            reviewSheetBody.innerHTML = `
                <section class="profile-review-sheet-section profile-review-sheet-section-plain profile-review-sheet-section-tight">
                    ${renderCurrentUserRow()}
                </section>

                <section class="profile-review-sheet-section profile-review-sheet-section-plain profile-review-sheet-section-grow">
                    <div class="profile-review-sheet-copy-group">
                        <div class="profile-review-sheet-rating-display">
                            <div class="profile-review-stars" aria-label="Rated ${escapeHtml(String(review.rating))} out of 5">
                                ${renderDisplayStars(review.rating)}
                            </div>
                            <span class="profile-review-sheet-meta">${escapeHtml(reviewDate)}</span>
                        </div>

                        <p class="profile-review-sheet-copy">${escapeHtml(reviewText)}</p>
                    </div>

                    ${review.photo_url ? `
                        <div class="profile-review-sheet-media-block">
                            <img
                                class="profile-review-sheet-photo"
                                src="${escapeHtml(review.photo_url)}"
                                alt="Review photo"
                            >
                            ${review.photo_id ? `
                                <button
                                    type="button"
                                    class="profile-review-sheet-secondary js-sheet-delete-photo"
                                    data-photo-id="${review.photo_id}"
                                >
                                    Remove photo
                                </button>
                            ` : ''}
                        </div>
                    ` : ''}
                </section>
            `;
            return;
        }

        setReviewSheetMenuVisible(false);
        reviewSheetHeaderCopy.innerHTML = `
            <h2 class="profile-review-sheet-title" id="review-sheet-title">${escapeHtml(amenityDisplayName)}</h2>
            ${renderAmenityTypeBadge(review)}
        `;

        reviewSheetBody.innerHTML = `
            <section class="profile-review-sheet-section profile-review-sheet-section-plain profile-review-sheet-section-tight">
                ${renderCurrentUserRow(false)}
            </section>

            <form id="review-sheet-edit-form" class="profile-review-sheet-form profile-review-sheet-section profile-review-sheet-section-plain profile-review-sheet-section-grow">
                ${renderStarPicker(review.rating)}

                <textarea
                    id="sheet-review-text"
                    class="profile-review-sheet-textarea js-sheet-review-text"
                    rows="7"
                    maxlength="600"
                    placeholder="Share your experience at this location..."
                >${escapeHtml(review.review_text || '')}</textarea>

                ${review.photo_url ? `
                    <div class="profile-review-sheet-media-block">
                        <img
                            class="profile-review-sheet-photo-thumb"
                            src="${escapeHtml(review.photo_url)}"
                            alt="Review photo"
                        >
                        ${review.photo_id ? `
                            <button
                                type="button"
                                class="profile-review-sheet-secondary js-sheet-delete-photo"
                                data-photo-id="${review.photo_id}"
                            >
                                Remove photo
                            </button>
                        ` : ''}
                    </div>
                ` : ''}

                <div class="profile-review-sheet-actions">
                    <button type="button" class="profile-review-sheet-secondary js-sheet-cancel-edit">Cancel</button>
                    <button type="button" class="profile-review-sheet-primary js-sheet-save" disabled>Save changes</button>
                </div>
            </form>
        `;

        syncReviewSheetSaveState();
    }


    async function fetchProfileReviews() {
        if (!reviewsState || !reviewsList) return;

        reviewsState.hidden = false;
        reviewsState.removeAttribute('hidden');
        reviewsState.textContent = 'Loading your reviews...';
        reviewsList.hidden = true;
        reviewsList.setAttribute('hidden', '');
        reviewsList.innerHTML = '';

        try {
            const response = await fetch(pageRoot.dataset.reviewsUrl, {
                method: 'GET',
                credentials: 'same-origin',
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                reviewsState.textContent = body.error || 'Unable to load reviews.';
                return;
            }

            state.reviews = Array.isArray(body.reviews) ? body.reviews : [];
            state.reviewsLoaded = true;
            renderReviews();
        } catch (error) {
            reviewsState.textContent = 'Network error while loading reviews.';
        }
    }

    async function fetchProfileFavorites() {
        if (!favoritesState || !favoritesList) return;

        favoritesState.hidden = false;
        favoritesState.removeAttribute('hidden');
        favoritesState.textContent = 'Loading your favorites...';
        favoritesList.hidden = true;
        favoritesList.setAttribute('hidden', '');
        favoritesList.innerHTML = '';

        try {
            const response = await fetch(pageRoot.dataset.favoritesUrl, {
                method: 'GET',
                credentials: 'same-origin',
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                favoritesState.textContent = body.error || 'Unable to load favorites.';
                return;
            }

            state.favorites = Array.isArray(body.favorites) ? body.favorites : [];
            state.favoritesLoaded = true;
            renderFavorites();
        } catch (error) {
            favoritesState.textContent = 'Network error while loading favorites.';
        }
    }

    function setupReviewActions() {
        if (!reviewsList) return;

        // Use event delegation because the review cards are re-rendered often.
        reviewsList.addEventListener('click', event => {
            const card = event.target.closest('.profile-review-card-clickable');
            if (!card) return;

            openReviewSheet(Number(card.dataset.reviewId));
        });

        reviewsList.addEventListener('keydown', event => {
            const card = event.target.closest('.profile-review-card-clickable');
            if (!card) return;

            if (event.key !== 'Enter' && event.key !== ' ') return;

            event.preventDefault();
            openReviewSheet(Number(card.dataset.reviewId));
        });
    }

    async function saveActiveReview() {
        const form = document.getElementById('review-sheet-edit-form');
        if (!form || !state.activeReviewId) return;
        const starPicker = form.querySelector('.js-sheet-star-picker');
        const textInput = form.querySelector('.js-sheet-review-text');
        if (!starPicker || !textInput) return;

        const payload = {
            rating: Math.min(5, Math.max(1, parseInt(starPicker.dataset.rating || '5', 10) || 5)),
            review_text: textInput.value.trim(),
        };

        try {
            const response = await fetch(`${pageRoot.dataset.updateReviewBase}${state.activeReviewId}/`, {
                method: 'PATCH',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                showToast(body.error || 'Unable to update this review.', 'error');
                return;
            }

            state.reviews = state.reviews.map(review => (
                review.id === state.activeReviewId ? body : review
            ));

            renderReviews();
            state.reviewSheetMode = 'view';
            renderReviewSheet();
            showToast(body.message || 'Review updated successfully.', 'success');
        } catch (error) {
            showToast('Network error while updating the review.', 'error');
        }
    }

    async function deleteActiveReview() {
        if (!state.activeReviewId) return;

        try {
            const response = await fetch(`${pageRoot.dataset.updateReviewBase}${state.activeReviewId}/`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                showToast(body.error || 'Unable to delete this review.', 'error');
                return;
            }

            state.reviews = state.reviews.filter(review => review.id !== state.activeReviewId);
            renderReviews();
            closeReviewSheet();
            showToast(body.message || 'Review deleted successfully.', 'success');
        } catch (error) {
            showToast('Network error while deleting the review.', 'error');
        }
    }

    async function deleteActiveReviewPhoto(photoId) {
        if (!state.activeReviewId || !photoId) return;

        try {
            const response = await fetch(`${pageRoot.dataset.updateReviewBase}${state.activeReviewId}/photos/${photoId}/`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                showToast(body.error || 'Unable to delete this photo.', 'error');
                return;
            }

            state.reviews = state.reviews.map(review => (
                review.id === state.activeReviewId ? body : review
            ));

            renderReviews();
            renderReviewSheet();
            showToast(body.message || 'Review photo deleted successfully.', 'success');
        } catch (error) {
            showToast('Network error while deleting the photo.', 'error');
        }
    }

    function openReviewSheet(reviewId) {
        if (!reviewSheet) return;

        if (reviewSheetHideTimer) {
            clearTimeout(reviewSheetHideTimer);
            reviewSheetHideTimer = null;
        }

        state.activeReviewId = reviewId;
        state.reviewSheetMode = 'view';
        reviewSheet.hidden = false;
        setReviewSheetMenuOpen(false);
        renderReviewSheet();

        document.body.classList.add('profile-review-sheet-open');
        requestAnimationFrame(() => {
            reviewSheet.classList.add('is-open');
            reviewSheetPanel?.focus();
        });
    }

    function closeReviewSheet() {
        if (!reviewSheet) return;

        state.activeReviewId = null;
        state.reviewSheetMode = 'view';
        reviewSheet.classList.remove('is-open');
        document.body.classList.remove('profile-review-sheet-open');
        setReviewSheetMenuVisible(false);

        reviewSheetHideTimer = window.setTimeout(() => {
            reviewSheet.hidden = true;
            reviewSheetHeaderCopy.innerHTML = '';
            reviewSheetBody.innerHTML = '';
            reviewSheetHideTimer = null;
        }, 280);
    }

    function setupReviewSheet() {
        if (!reviewSheet || !reviewSheetBody) return;

        if (reviewSheetClose) {
            reviewSheetClose.addEventListener('click', closeReviewSheet);
        }

        if (reviewSheetBackdrop) {
            reviewSheetBackdrop.addEventListener('click', closeReviewSheet);
        }

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && state.activeReviewId) {
                closeReviewSheet();
            }
        });

        document.addEventListener('click', event => {
            const { wrap } = getReviewSheetMenuElements();
            if (!wrap || wrap.hidden) return;
            if (wrap.contains(event.target)) return;
            setReviewSheetMenuOpen(false);
        });

        reviewSheetBody.addEventListener('input', event => {
            if (event.target.closest('.js-sheet-review-text')) {
                syncReviewSheetSaveState();
            }
        });

        reviewSheet.addEventListener('click', event => {
            const menuButton = event.target.closest('#review-sheet-menu-button');
            if (menuButton) {
                event.stopPropagation();
                const { dropdown } = getReviewSheetMenuElements();
                setReviewSheetMenuOpen(dropdown?.hidden !== false);
                return;
            }

            const starButton = event.target.closest('.js-sheet-star');
            if (starButton) {
                const value = Number(starButton.dataset.value);
                const starPicker = reviewSheetBody.querySelector('.js-sheet-star-picker');
                if (!starPicker || !Number.isFinite(value)) return;

                starPicker.dataset.rating = String(value);

                reviewSheetBody.querySelectorAll('.js-sheet-star').forEach(button => {
                    const starValue = Number(button.dataset.value);
                    button.classList.toggle('lit', starValue <= value);
                });
                syncReviewSheetSaveState();
                return;
            }

            if (event.target.closest('.js-sheet-header-edit')) {
                setReviewSheetMenuOpen(false);
                setReviewSheetMode('edit');
                return;
            }

            if (event.target.closest('.js-sheet-header-delete')) {
                setReviewSheetMenuOpen(false);
                setReviewSheetMode('confirm_delete');
                return;
            }

            const deletePhotoButton = event.target.closest('.js-sheet-delete-photo');
            if (deletePhotoButton) {
                const photoId = Number(deletePhotoButton.dataset.photoId);
                if (!Number.isFinite(photoId)) return;

                deleteActiveReviewPhoto(photoId);
                return;
            }

            if (event.target.closest('.js-sheet-cancel-edit')) {
                setReviewSheetMode('view');
                return;
            }

            if (event.target.closest('.js-sheet-save')) {
                if (!hasPendingReviewChanges()) return;
                saveActiveReview();
                return;
            }

            if (event.target.closest('.js-sheet-cancel-delete')) {
                setReviewSheetMode('view');
                return;
            }

            if (event.target.closest('.js-sheet-confirm-delete')) {
                deleteActiveReview();
            }
        });
    }

    function setReviewSheetMode(mode) {
        state.reviewSheetMode = mode;
        renderReviewSheet();
    }

    function showToast(msg, type = 'info', duration = 2800) {
        const existing = document.getElementById('app-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'app-toast';
        toast.className = `app-toast is-${type}`;
        toast.textContent = msg;

        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('is-visible');
        });

        setTimeout(() => {
            toast.classList.remove('is-visible');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    setupDropdown();
    setupLogout();
    setupTabs();
    setupReviewActions();
    setupReviewSheet();
    setActiveTab('reviews');
});
