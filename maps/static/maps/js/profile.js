document.addEventListener('DOMContentLoaded', () => {
    const pageRoot = document.getElementById('profile-page-root');
    if (!pageRoot) return;

    const state = {
        reviews: [],
        reviewsLoaded: false,
        activeReviewId: null,
        reviewModalMode: 'view',
    };

    const dropdown = document.getElementById('user-menu-dropdown');
    const dropdownToggle = document.getElementById('avatar-button');
    const logoutButton = document.getElementById('logout-link');

    const tabButtons = Array.from(document.querySelectorAll('.profile-tab'));
    const tabPanels = Array.from(document.querySelectorAll('.profile-tab-panel'));

    const reviewsState = document.getElementById('profile-reviews-state');
    const reviewsList = document.getElementById('profile-reviews-list');

    const reviewModal = document.getElementById('review-modal');
    const reviewModalBody = document.getElementById('review-modal-body');
    const reviewModalClose = document.getElementById('review-modal-close');
    const reviewModalBackdrop = document.getElementById('review-modal-backdrop');
    const reviewModalDialog = reviewModal ? reviewModal.querySelector('.profile-modal-dialog') : null;

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

    function setActiveTab(tabName) {
        tabButtons.forEach(button => {
            const isActive = button.dataset.tab === tabName;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', String(isActive));
        });

        tabPanels.forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panel === tabName);
        });

        // Lazy-load reviews only when the user first opens the tab.
        if (tabName === 'reviews' && !state.reviewsLoaded) {
            fetchProfileReviews();
        }
    }

    function setupTabs() {
        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                setActiveTab(button.dataset.tab);
            });
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
                    class="star-btn js-modal-star ${value <= score ? 'lit' : ''}"
                    data-value="${value}"
                    aria-label="Rate ${value} star${value === 1 ? '' : 's'}"
                >★</button>
            `)
            .join('');

        return `
            <div class="star-picker js-modal-star-picker" data-rating="${score}" role="radiogroup" aria-label="Review rating">
                ${stars}
            </div>
        `;
    }

    function renderReviewCard(review) {
        return `
            <article
                class="profile-review-card profile-review-card-clickable"
                data-review-id="${review.id}"
                tabindex="0"
                role="button"
                aria-label="Open review for ${escapeHtml(review.amenity_name)}"
            >
                <div class="profile-review-card-top">
                    <div>
                        <div class="profile-review-place">${escapeHtml(review.amenity_name)}</div>
                        <div class="profile-review-address">${escapeHtml(review.amenity_address || 'Address unavailable')}</div>
                    </div>
                    <div class="profile-review-date">${escapeHtml(formatDate(review.updated_at || review.created_at))}</div>
                </div>

                <div class="profile-review-rating-row">
                    <div class="profile-review-stars" aria-label="Rated ${escapeHtml(String(review.rating))} out of 5">
                        ${renderDisplayStars(review.rating)}
                    </div>
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
            `;
            reviewsList.hidden = true;
            reviewsList.innerHTML = '';
            return;
        }

        reviewsState.hidden = true;
        reviewsList.hidden = false;
        reviewsList.innerHTML = state.reviews.map(renderReviewCard).join('');
    }

    function renderReviewModal() {
        if (!reviewModal || !reviewModalBody || !state.activeReviewId) return;

        const review = state.reviews.find(item => item.id === state.activeReviewId);
        if (!review) {
            closeReviewModal();
            return;
        }

        const isEditMode = state.reviewModalMode === 'edit';
        const isDeleteMode = state.reviewModalMode === 'confirm_delete';
        const reviewText = review.review_text || 'No written comment.';
        const reviewDate = formatDate(review.updated_at || review.created_at);

        reviewModal.hidden = false;
        if (reviewModalDialog) {
            reviewModalDialog.classList.toggle('profile-modal-dialog-compact', isDeleteMode);
        }

        if (isDeleteMode) {
            reviewModalBody.innerHTML = `
                <div class="profile-modal-header">
                    <div>
                        <div class="profile-modal-title" id="review-modal-title">Delete review?</div>
                    </div>
                </div>

                <p class="profile-modal-copy">
                    This action cannot be undone.
                </p>

                <div class="profile-modal-actions">
                    <button type="button" class="profile-modal-secondary js-modal-cancel-delete">Cancel</button>
                    <button type="button" class="profile-modal-danger js-modal-confirm-delete">Delete</button>
                </div>
            `;
            return;
        }

        if (!isEditMode) {
            reviewModalBody.innerHTML = `
                <div class="profile-modal-header">
                    <div>
                        <div class="profile-modal-title" id="review-modal-title">${escapeHtml(review.amenity_name)}</div>
                        <div class="profile-modal-subtle">${escapeHtml(review.amenity_address || 'Address unavailable')}</div>
                    </div>
                </div>

                <div class="profile-modal-rating-display">
                    <div class="profile-review-stars" aria-label="Rated ${escapeHtml(String(review.rating))} out of 5">
                        ${renderDisplayStars(review.rating)}
                    </div>
                    <span class="profile-modal-meta">${escapeHtml(reviewDate)}</span>
                </div>

                <p class="profile-modal-copy">${escapeHtml(reviewText)}</p>

                ${review.photo_url ? `
                    <img
                        class="profile-modal-photo"
                        src="${escapeHtml(review.photo_url)}"
                        alt="Review photo"
                    >
                ` : ''}

                <div class="profile-modal-actions">
                    <button type="button" class="profile-modal-secondary js-modal-edit">Edit</button>
                </div>
            `;
            return;
        }

        reviewModalBody.innerHTML = `
            <div class="profile-modal-header">
                <div>
                    <div class="profile-modal-title" id="review-modal-title">${escapeHtml(review.amenity_name)}</div>
                    <div class="profile-modal-subtle">${escapeHtml(review.amenity_address || 'Address unavailable')}</div>
                </div>
            </div>

            <form id="review-modal-edit-form" class="profile-modal-form">
                ${renderStarPicker(review.rating)}

                <textarea
                    id="modal-review-text"
                    class="profile-modal-textarea js-modal-review-text"
                    rows="7"
                    maxlength="600"
                    placeholder="Share your experience at this location..."
                >${escapeHtml(review.review_text || '')}</textarea>

                ${review.photo_url ? `
                    <img
                        class="profile-modal-photo-thumb"
                        src="${escapeHtml(review.photo_url)}"
                        alt="Review photo"
                    >
                ` : ''}

                <div class="profile-modal-actions">
                    <button type="button" class="profile-modal-danger profile-modal-danger-left js-modal-request-delete">Delete</button>
                    <button type="button" class="profile-modal-secondary js-modal-cancel-edit">Cancel</button>
                    <button type="button" class="profile-modal-primary js-modal-save">Save changes</button>
                </div>
            </form>
        `;
    }


    async function fetchProfileReviews() {
        if (!reviewsState) return;

        reviewsState.hidden = false;
        reviewsState.textContent = 'Loading your reviews...';
        reviewsList.hidden = true;

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

    function setupReviewActions() {
        if (!reviewsList) return;

        // Use event delegation because the review cards are re-rendered often.
        reviewsList.addEventListener('click', event => {
            const card = event.target.closest('.profile-review-card-clickable');
            if (!card) return;

            openReviewModal(Number(card.dataset.reviewId));
        });

        reviewsList.addEventListener('keydown', event => {
            const card = event.target.closest('.profile-review-card-clickable');
            if (!card) return;

            if (event.key !== 'Enter' && event.key !== ' ') return;

            event.preventDefault();
            openReviewModal(Number(card.dataset.reviewId));
        });
    }

    async function saveActiveReview() {
        const form = document.getElementById('review-modal-edit-form');
        if (!form || !state.activeReviewId) return;
        const starPicker = form.querySelector('.js-modal-star-picker');
        const textInput = form.querySelector('.js-modal-review-text');
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
            closeReviewModal();
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
            closeReviewModal();
            showToast(body.message || 'Review deleted successfully.', 'success');
        } catch (error) {
            showToast('Network error while deleting the review.', 'error');
        }
    }

    function openReviewModal(reviewId) {
        state.activeReviewId = reviewId;
        state.reviewModalMode = 'view';
        renderReviewModal();
    }

    function closeReviewModal() {
        if (!reviewModal) return;

        state.activeReviewId = null;
        state.reviewModalMode = 'view';
        reviewModal.hidden = true;
        if (reviewModalDialog) {
            reviewModalDialog.classList.remove('profile-modal-dialog-compact');
        }
        reviewModalBody.innerHTML = '';
    }

    function setupReviewModal() {
        if (!reviewModal || !reviewModalBody) return;

        if (reviewModalClose) {
            reviewModalClose.addEventListener('click', closeReviewModal);
        }

        if (reviewModalBackdrop) {
            reviewModalBackdrop.addEventListener('click', closeReviewModal);
        }

        reviewModalBody.addEventListener('click', event => {
            const starButton = event.target.closest('.js-modal-star');
            if (starButton) {
                const value = Number(starButton.dataset.value);
                const starPicker = reviewModalBody.querySelector('.js-modal-star-picker');
                if (!starPicker || !Number.isFinite(value)) return;

                starPicker.dataset.rating = String(value);

                reviewModalBody.querySelectorAll('.js-modal-star').forEach(button => {
                    const starValue = Number(button.dataset.value);
                    button.classList.toggle('lit', starValue <= value);
                });
                return;
            }

            if (event.target.closest('.js-modal-edit')) {
                setReviewModalMode('edit');
                return;
            }

            if (event.target.closest('.js-modal-cancel-edit')) {
                setReviewModalMode('view');
                return;
            }

            if (event.target.closest('.js-modal-save')) {
                saveActiveReview();
                return;
            }

            if (event.target.closest('.js-modal-request-delete')) {
                setReviewModalMode('confirm_delete');
                return;
            }

            if (event.target.closest('.js-modal-cancel-delete')) {
                setReviewModalMode('view');
                return;
            }

            if (event.target.closest('.js-modal-confirm-delete')) {
                deleteActiveReview();
            }
        });
    }

    function setReviewModalMode(mode) {
        state.reviewModalMode = mode;
        renderReviewModal();
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

    function consumeStoredToast() {
        const raw = sessionStorage.getItem('profileToast');
        if (!raw) return;

        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.kind && parsed.message) {
                showToast(parsed.message, parsed.kind);
            }
        } catch (error) {
            // Ignore malformed session storage data.
        }

        sessionStorage.removeItem('profileToast');
    }

    setupTabs();
    setupDropdown();
    setupLogout();
    setupReviewActions();
    setupReviewModal();
    setActiveTab('info');
    consumeStoredToast();
});
