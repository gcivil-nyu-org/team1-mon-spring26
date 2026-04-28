document.addEventListener('DOMContentLoaded', () => {
    const pageRoot = document.getElementById('profile-page-root');
    if (!pageRoot) return;

    const isOwnProfile = pageRoot.dataset.isOwnProfile === 'true';

    const state = {
        reviews: [],
        reviewsLoaded: false,
        favorites: [],
        favoritesLoaded: false,
        activeReviewId: null,
        reviewSheetMode: 'view',
        pendingReviewPhotos: [],
        nextPendingReviewPhotoId: 1,
        pendingDeletePhotoIds: [],
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

    function renderThumbIcon(direction, filled) {
        if (direction === 'down') {
            return filled
                ? '<svg class="review-vote-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.956 14.534c.065.936.952 1.659 1.908 1.42l.261-.065a1.38 1.38 0 0 0 1.012-.965c.22-.816.533-2.512.062-4.51q.205.03.443.051c.713.065 1.669.071 2.516-.211.518-.173.994-.68 1.2-1.272a1.9 1.9 0 0 0-.234-1.734c.058-.118.103-.242.138-.362.077-.27.113-.568.113-.856 0-.29-.036-.586-.113-.857a2 2 0 0 0-.16-.403c.169-.387.107-.82-.003-1.149a3.2 3.2 0 0 0-.488-.9c.054-.153.076-.313.076-.465a1.86 1.86 0 0 0-.253-.912C13.1.757 12.437.28 11.5.28H8c-.605 0-1.07.08-1.466.217a4.8 4.8 0 0 0-.97.485l-.048.029c-.504.308-.999.61-2.068.723C2.682 1.815 2 2.434 2 3.279v4c0 .851.685 1.433 1.357 1.616.849.232 1.574.787 2.132 1.41.56.626.914 1.28 1.039 1.638.199.575.356 1.54.428 2.591"/></svg>'
                : '<svg class="review-vote-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8.864 15.674c-.956.24-1.843-.484-1.908-1.42-.072-1.05-.23-2.015-.428-2.59-.125-.36-.479-1.012-1.04-1.638-.557-.624-1.282-1.179-2.131-1.41C2.685 8.432 2 7.85 2 7V3c0-.845.682-1.464 1.448-1.546 1.07-.113 1.564-.415 2.068-.723l.048-.029c.272-.166.578-.349.97-.484C6.931.08 7.395 0 8 0h3.5c.937 0 1.599.478 1.934 1.064.164.287.254.607.254.913 0 .152-.023.312-.077.464.201.262.38.577.488.9.11.33.172.762.004 1.15.069.13.12.268.159.403.077.27.113.567.113.856s-.036.586-.113.856c-.035.12-.08.244-.138.363.394.571.418 1.2.234 1.733-.206.592-.682 1.1-1.2 1.272-.847.283-1.803.276-2.516.211a10 10 0 0 1-.443-.05 9.36 9.36 0 0 1-.062 4.51c-.138.508-.55.848-1.012.964zM11.5 1H8c-.51 0-.863.068-1.14.163-.281.097-.506.229-.776.393l-.04.025c-.555.338-1.198.73-2.49.868-.333.035-.554.29-.554.55V7c0 .255.226.543.62.65 1.095.3 1.977.997 2.614 1.709.635.71 1.064 1.475 1.238 1.977.243.7.407 1.768.482 2.85.025.362.36.595.667.518l.262-.065c.16-.04.258-.144.288-.255a8.34 8.34 0 0 0-.145-4.726.5.5 0 0 1 .595-.643h.003l.014.004.058.013a9 9 0 0 0 1.036.157c.663.06 1.457.054 2.11-.163.175-.059.45-.301.57-.651.107-.308.087-.67-.266-1.021L12.793 7l.353-.354c.043-.042.105-.14.154-.315.048-.167.075-.37.075-.581s-.027-.414-.075-.581c-.05-.174-.111-.273-.154-.315l-.353-.354.353-.354c.047-.047.109-.176.005-.488a2.2 2.2 0 0 0-.505-.804l-.353-.354.353-.354c.006-.005.041-.05.041-.17a.9.9 0 0 0-.121-.415C12.4 1.272 12.063 1 11.5 1"/></svg>';
        }

        return filled
            ? '<svg class="review-vote-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.956 1.745C7.021.81 7.908.087 8.864.325l.261.066c.463.116.874.456 1.012.965.22.816.533 2.511.062 4.51a10 10 0 0 1 .443-.051c.713-.065 1.669-.072 2.516.21.518.173.994.681 1.2 1.273.184.532.16 1.162-.234 1.733q.086.18.138.363c.077.27.113.567.113.856s-.036.586-.113.856c-.039.135-.09.273-.16.404.169.387.107.819-.003 1.148a3.2 3.2 0 0 1-.488.901c.054.152.076.312.076.465 0 .305-.089.625-.253.912C13.1 15.522 12.437 16 11.5 16H8c-.605 0-1.07-.081-1.466-.218a4.8 4.8 0 0 1-.97-.484l-.048-.03c-.504-.307-.999-.609-2.068-.722C2.682 14.464 2 13.846 2 13V9c0-.85.685-1.432 1.357-1.615.849-.232 1.574-.787 2.132-1.41.56-.627.914-1.28 1.039-1.639.199-.575.356-1.539.428-2.59z"/></svg>'
            : '<svg class="review-vote-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8.864.046C7.908-.193 7.02.53 6.956 1.466c-.072 1.051-.23 2.016-.428 2.59-.125.36-.479 1.013-1.04 1.639-.557.623-1.282 1.178-2.131 1.41C2.685 7.288 2 7.87 2 8.72v4.001c0 .845.682 1.464 1.448 1.545 1.07.114 1.564.415 2.068.723l.048.03c.272.165.578.348.97.484.397.136.861.217 1.466.217h3.5c.937 0 1.599-.477 1.934-1.064a1.86 1.86 0 0 0 .254-.912c0-.152-.023-.312-.077-.464.201-.263.38-.578.488-.901.11-.33.172-.762.004-1.149.069-.13.12-.269.159-.403.077-.27.113-.568.113-.857 0-.288-.036-.585-.113-.856a2 2 0 0 0-.138-.362 1.9 1.9 0 0 0 .234-1.734c-.206-.592-.682-1.1-1.2-1.272-.847-.282-1.803-.276-2.516-.211a10 10 0 0 0-.443.05 9.4 9.4 0 0 0-.062-4.509A1.38 1.38 0 0 0 9.125.111zM11.5 14.721H8c-.51 0-.863-.069-1.14-.164-.281-.097-.506-.228-.776-.393l-.04-.024c-.555-.339-1.198-.731-2.49-.868-.333-.036-.554-.29-.554-.55V8.72c0-.254.226-.543.62-.65 1.095-.3 1.977-.996 2.614-1.708.635-.71 1.064-1.475 1.238-1.978.243-.7.407-1.768.482-2.85.025-.362.36-.594.667-.518l.262.066c.16.04.258.143.288.255a8.34 8.34 0 0 1-.145 4.725.5.5 0 0 0 .595.644l.003-.001.014-.003.058-.014a9 9 0 0 1 1.036-.157c.663-.06 1.457-.054 2.11.164.175.058.45.3.57.65.107.308.087.67-.266 1.022l-.353.353.353.354c.043.043.105.141.154.315.048.167.075.37.075.581 0 .212-.027.414-.075.582-.05.174-.111.272-.154.315l-.353.353.353.354c.047.047.109.177.005.488a2.2 2.2 0 0 1-.505.805l-.353.353.353.354c.006.005.041.05.041.17a.9.9 0 0 1-.121.416c-.165.288-.503.56-1.066.56z"/></svg>';
    }

    function renderProfileVoteControls(review) {
        const reviewId = Number(review.id || 0);
        if (!reviewId) return '';

        const userVote = Number(review.user_vote || 0);
        const voteScore = Number(review.vote_score || 0);
        const upvoteCount = review.upvote_count !== undefined && review.upvote_count !== null
            ? Number(review.upvote_count || 0)
            : Math.max(voteScore, 0);
        const downvoteCount = review.downvote_count !== undefined && review.downvote_count !== null
            ? Number(review.downvote_count || 0)
            : Math.max(-voteScore, 0);
        const title = isOwnProfile ? 'You cannot vote on your own review' : 'Vote on this review';
        const upvoteLabel = `${upvoteCount} ${upvoteCount === 1 ? 'like' : 'likes'}`;
        const downvoteLabel = `${downvoteCount} ${downvoteCount === 1 ? 'dislike' : 'dislikes'}`;
        const optionClass = `review-vote-option${isOwnProfile ? ' is-readonly' : ''}`;

        return `
            <div class="review-vote-row profile-review-sheet-vote-row" data-review-vote-row="${reviewId}">
                <span class="${optionClass}" title="${isOwnProfile ? title : upvoteLabel}">
                    <button type="button" class="review-vote-btn js-profile-vote-btn up ${userVote === 1 ? 'active' : ''}" data-review-id="${reviewId}" data-vote="1" ${isOwnProfile ? 'disabled' : ''} title="${isOwnProfile ? title : upvoteLabel}" aria-label="Upvote review" aria-pressed="${userVote === 1}">${renderThumbIcon('up', userVote === 1)}</button>
                    <span class="review-vote-count ${upvoteCount > 0 ? '' : 'is-empty'}" aria-label="${upvoteLabel}" aria-hidden="${upvoteCount > 0 ? 'false' : 'true'}">${upvoteCount}</span>
                </span>
                <span class="${optionClass}" title="${isOwnProfile ? title : downvoteLabel}">
                    <button type="button" class="review-vote-btn js-profile-vote-btn down ${userVote === -1 ? 'active' : ''}" data-review-id="${reviewId}" data-vote="-1" ${isOwnProfile ? 'disabled' : ''} title="${isOwnProfile ? title : downvoteLabel}" aria-label="Downvote review" aria-pressed="${userVote === -1}">${renderThumbIcon('down', userVote === -1)}</button>
                    <span class="review-vote-count ${downvoteCount > 0 ? '' : 'is-empty'}" aria-label="${downvoteLabel}" aria-hidden="${downvoteCount > 0 ? 'false' : 'true'}">${downvoteCount}</span>
                </span>
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

    function getReviewPhotos(review) {
        const urls = Array.isArray(review.photo_urls)
            ? review.photo_urls.filter(url => typeof url === 'string' && url.trim())
            : [];
        const ids = Array.isArray(review.photo_ids) ? review.photo_ids : [];

        if (urls.length) {
            return urls.map((url, index) => {
                const idValue = Number(ids[index]);
                return {
                    url,
                    id: Number.isFinite(idValue) ? idValue : null,
                };
            });
        }

        const fallbackUrl = typeof review.photo_url === 'string' ? review.photo_url.trim() : '';
        if (!fallbackUrl) return [];

        const fallbackId = Number(review.photo_id);
        return [{
            url: fallbackUrl,
            id: Number.isFinite(fallbackId) ? fallbackId : null,
        }];
    }

    function getPendingReviewPhotos() {
        return Array.isArray(state.pendingReviewPhotos) ? state.pendingReviewPhotos : [];
    }

    function clearPendingReviewPhotos() {
        getPendingReviewPhotos().forEach(photo => {
            if (photo && photo.previewUrl) {
                URL.revokeObjectURL(photo.previewUrl);
            }
        });
        state.pendingReviewPhotos = [];
        state.pendingDeletePhotoIds = [];
    }

    function renderReviewCardPhotos(review) {
        const photos = getReviewPhotos(review);
        if (!photos.length) return '';

        return `
            <div class="profile-review-photo-grid">
                ${photos.map((photo, index) => `
                    <img
                        class="profile-review-photo"
                        src="${escapeHtml(photo.url)}"
                        alt="Review photo ${index + 1}"
                    >
                `).join('')}
            </div>
        `;
    }

    function renderReviewSheetPhotoGallery(review, editable = false) {
        const allExistingPhotos = getReviewPhotos(review);
        const existingPhotos = editable
            ? allExistingPhotos.filter(p => !state.pendingDeletePhotoIds.includes(p.id))
            : allExistingPhotos;
        const pendingPhotos = editable ? getPendingReviewPhotos() : [];
        const totalPhotoCount = existingPhotos.length + pendingPhotos.length;

        if (!editable && !existingPhotos.length) return '';

        if (!editable) {
            return `
                <div class="profile-review-sheet-view-photo-list">
                    ${existingPhotos.map((photo, index) => `
                        <img
                            class="profile-review-sheet-view-photo"
                            src="${escapeHtml(photo.url)}"
                            alt="Review photo ${index + 1}"
                        >
                    `).join('')}
                </div>
            `;
        }

        const cards = [];

        existingPhotos.forEach((photo, index) => {
            cards.push(`
                <div class="profile-review-sheet-gallery-card">
                    <img
                        class="profile-review-sheet-gallery-photo"
                        src="${escapeHtml(photo.url)}"
                        alt="Review photo ${index + 1}"
                    >
                    ${editable && photo.id ? `
                        <button
                            type="button"
                            class="profile-review-sheet-photo-delete js-sheet-delete-photo"
                            data-photo-id="${photo.id}"
                            aria-label="Remove photo ${index + 1}"
                        >×</button>
                    ` : ''}
                </div>
            `);
        });

        pendingPhotos.forEach((photo, index) => {
            cards.push(`
                <div class="profile-review-sheet-gallery-card is-pending">
                    <img
                        class="profile-review-sheet-gallery-photo"
                        src="${escapeHtml(photo.previewUrl)}"
                        alt="New review photo ${index + 1}"
                    >
                    <button
                        type="button"
                        class="profile-review-sheet-photo-delete js-sheet-delete-pending-photo"
                        data-temp-id="${photo.tempId}"
                        aria-label="Remove new photo ${index + 1}"
                    >×</button>
                </div>
            `);
        });

        if (editable && totalPhotoCount < 5) {
            cards.push(`
                <button
                    type="button"
                    class="profile-review-sheet-add-photo js-sheet-add-photo"
                    aria-label="Add photo"
                >
                    <span class="profile-review-sheet-add-photo-plus">+</span>
                    <span class="profile-review-sheet-add-photo-label">Add photo</span>
                </button>
            `);
        }

        return `
            <div class="profile-review-sheet-gallery-wrap">
                <div class="profile-review-sheet-gallery" role="list">
                    ${cards.join('')}
                </div>
                ${editable ? `
                    <input
                        type="file"
                        class="js-sheet-photo-input"
                        accept="image/*"
                        multiple
                        hidden
                    >
                ` : ''}
            </div>
        `;
    }

    function renderCurrentUserRow(showMenu = true) {
        const reviewerName = String(pageRoot.dataset.currentUserName || '').trim() || 'You';
        const avatarUrl = String(pageRoot.dataset.currentUserAvatar || '').trim();
        const canShowMenu = Boolean(showMenu && isOwnProfile);

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

                ${canShowMenu ? `
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
        const clickableAttrs = `class="profile-review-card profile-review-card-clickable" data-review-id="${review.id}" tabindex="0" role="button" aria-label="Open review for ${escapeHtml(amenityDisplayName)}"`;

        return `
            <article
                ${clickableAttrs}
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

                ${renderReviewCardPhotos(review)}
            </article>
        `;
    }

    function renderReviews() {
        if (!reviewsState || !reviewsList) return;

        if (!state.reviews.length) {
            reviewsState.hidden = false;
            if (isOwnProfile) {
                reviewsState.innerHTML = `
                    <div class="profile-empty-title">You haven't written any reviews yet.</div>
                    <p class="profile-empty-copy">Your reviews will appear here once you start sharing feedback.</p>
                `;
            } else {
                const name = escapeHtml(String(pageRoot.dataset.currentUserName || '').trim() || 'This user');
                reviewsState.innerHTML = `
                    <div class="profile-empty-title">${name} hasn't written any reviews yet.</div>
                `;
            }
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
        const isChecked = favorite.notify_on_updates !== false;

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

                ${isOwnProfile ? `<label class="favorite-notify-row">
                    <input
                        class="favorite-notify-checkbox js-favorite-notify-toggle"
                        type="checkbox"
                        data-favorite-id="${favorite.id}"
                        ${isChecked ? 'checked' : ''}
                    >
                    <span>Notify me when new reviews are added</span>
                </label>` : ''}

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
            if (isOwnProfile) {
                favoritesState.innerHTML = `
                    <div class="profile-empty-title">No favorites yet.</div>
                    <p class="profile-empty-copy">Save places from the map and they will appear here.</p>
                `;
            } else {
                const name = escapeHtml(String(pageRoot.dataset.currentUserName || '').trim() || 'This user');
                favoritesState.innerHTML = `
                    <div class="profile-empty-title">${name} has no favorites yet.</div>
                `;
            }
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
        if (getPendingReviewPhotos().length > 0 || state.pendingDeletePhotoIds.length > 0) {
            return true;
        }

        const review = getActiveReview();
        const form = document.getElementById('review-sheet-edit-form');
        if (!review || !form) return false;

        const starPicker = form.querySelector('.js-sheet-star-picker');
        const textInput = form.querySelector('.js-sheet-review-text');
        if (!starPicker || !textInput) return false;

        const rating = Math.min(5, Math.max(1, parseInt(starPicker.dataset.rating || '5', 10) || 5));
        const reviewText = textInput.value.trim();

        return (
            rating !== Number(review.rating || 0) ||
            reviewText !== String(review.review_text || '')
        );
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
        if (!isOwnProfile && (isEditMode || isDeleteMode)) {
            state.reviewSheetMode = 'view';
            renderReviewSheet();
            return;
        }
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
            setReviewSheetMenuVisible(isOwnProfile);
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

                    ${renderReviewSheetPhotoGallery(review, false)}
                    ${renderProfileVoteControls(review)}
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

                ${renderReviewSheetPhotoGallery(review, true)}

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
        reviewsState.textContent = isOwnProfile ? 'Loading your reviews...' : 'Loading reviews...';
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
        favoritesState.textContent = isOwnProfile ? 'Loading your favorites...' : 'Loading favorites...';
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

    async function updateFavoriteNotificationPreference(favoriteId, notifyOnUpdates, checkbox) {
        const originalChecked = !notifyOnUpdates;
        checkbox.disabled = true;

        try {
            const response = await fetch(`${pageRoot.dataset.favoriteNotificationBase}${favoriteId}/notifications/`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    notify_on_updates: notifyOnUpdates,
                }),
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                checkbox.checked = originalChecked;
                showToast(body.error || 'Unable to update notification preference.', 'error');
                return;
            }

            state.favorites = state.favorites.map(favorite => (
                favorite.id === favoriteId
                    ? { ...favorite, notify_on_updates: notifyOnUpdates }
                    : favorite
            ));
        } catch (error) {
            checkbox.checked = originalChecked;
            showToast('Network error while updating notification preference.', 'error');
        } finally {
            checkbox.disabled = false;
        }
    }

    function setupFavoriteActions() {
        if (!favoritesList) return;

        favoritesList.addEventListener('change', event => {
            const toggle = event.target.closest('.js-favorite-notify-toggle');
            if (!toggle) return;

            const favoriteId = Number(toggle.dataset.favoriteId);
            if (!Number.isFinite(favoriteId)) {
                toggle.checked = !toggle.checked;
                showToast('Invalid favorite selection.', 'error');
                return;
            }

            updateFavoriteNotificationPreference(favoriteId, toggle.checked, toggle);
        });
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

    async function submitProfileReviewVote(clickedButton) {
        if (isOwnProfile || !clickedButton || clickedButton.dataset.pending === 'true') return;

        const reviewId = Number(clickedButton.dataset.reviewId || 0);
        const requestedVote = Number(clickedButton.dataset.vote || 0);
        if (!reviewId || !requestedVote) return;

        const review = state.reviews.find(item => Number(item.id) === reviewId);
        if (!review) {
            showToast('Could not find that review.', 'error');
            return;
        }

        const currentVote = Number(review.user_vote || 0);
        const payloadVote = currentVote === requestedVote ? 'clear' : requestedVote;
        const row = reviewSheet ? reviewSheet.querySelector(`[data-review-vote-row="${reviewId}"]`) : null;
        const buttons = row ? row.querySelectorAll('.js-profile-vote-btn') : [clickedButton];
        buttons.forEach(button => {
            button.dataset.pending = 'true';
            button.setAttribute('aria-disabled', 'true');
        });

        try {
            const response = await fetch(`${pageRoot.dataset.updateReviewBase}${reviewId}/vote/`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ vote: payloadVote }),
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                showToast(body.error || 'Unable to save vote.', 'error');
                return;
            }

            state.reviews = state.reviews.map(item => (
                Number(item.id) === reviewId
                    ? {
                        ...item,
                        vote_score: Number(body.vote_score || 0),
                        upvote_count: Number(body.upvote_count || 0),
                        downvote_count: Number(body.downvote_count || 0),
                        user_vote: Number(body.user_vote || 0),
                    }
                    : item
            ));

            if (state.activeReviewId === reviewId && state.reviewSheetMode === 'view') {
                renderReviewSheet();
            }
        } catch (error) {
            showToast('Network error while saving vote.', 'error');
        } finally {
            if (reviewSheet && reviewSheet.querySelector(`[data-review-vote-row="${reviewId}"]`) === row) {
                buttons.forEach(button => {
                    delete button.dataset.pending;
                    button.removeAttribute('aria-disabled');
                });
            }
        }
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
        const formData = new FormData();
        formData.append('rating', String(payload.rating));
        formData.append('review_text', payload.review_text);
        getPendingReviewPhotos().forEach(photo => {
            formData.append('photos', photo.file);
        });

        try {
            const photoIdsToDelete = [...state.pendingDeletePhotoIds];
            if (photoIdsToDelete.length) {
                const deleteResults = await Promise.all(
                    photoIdsToDelete.map(photoId =>
                        fetch(`${pageRoot.dataset.updateReviewBase}${state.activeReviewId}/photos/${photoId}/`, {
                            method: 'DELETE',
                            credentials: 'same-origin',
                        }).then(r => ({ photoId, ok: r.ok })).catch(() => ({ photoId, ok: false }))
                    )
                );
                const failed = deleteResults.filter(r => !r.ok);
                if (failed.length) {
                    showToast('Some photos could not be deleted.', 'error');
                    return;
                }
            }

            const response = await fetch(`${pageRoot.dataset.updateReviewBase}${state.activeReviewId}/`, {
                method: 'PATCH',
                credentials: 'same-origin',
                body: formData,
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                showToast(body.error || 'Unable to update this review.', 'error');
                return;
            }

            state.reviews = state.reviews.map(review => (
                review.id === state.activeReviewId ? body : review
            ));

            clearPendingReviewPhotos();
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


    function openReviewSheet(reviewId) {
        if (!reviewSheet) return;

        if (reviewSheetHideTimer) {
            clearTimeout(reviewSheetHideTimer);
            reviewSheetHideTimer = null;
        }

        clearPendingReviewPhotos();
        state.activeReviewId = reviewId;
        state.reviewSheetMode = 'view';
        reviewSheet.hidden = false;
        setReviewSheetMenuVisible(false);
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

        clearPendingReviewPhotos();
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
            if (!isOwnProfile) return;
            if (event.target.closest('.js-sheet-review-text')) {
                syncReviewSheetSaveState();
            }
        });

        reviewSheetBody.addEventListener('change', event => {
            if (!isOwnProfile) return;
            const input = event.target.closest('.js-sheet-photo-input');
            if (!input) return;

            const review = getActiveReview();
            if (!review) return;

            const existingCount = getReviewPhotos(review).length;
            const currentPendingCount = getPendingReviewPhotos().length;
            const availableSlots = Math.max(0, 5 - existingCount - currentPendingCount);
            const selectedFiles = Array.from(input.files || []);

            if (!selectedFiles.length) return;

            if (availableSlots <= 0) {
                showToast('You can upload up to 5 photos per review.', 'warn');
                input.value = '';
                return;
            }

            const nextPhotos = [];
            let skippedForLimit = false;

            selectedFiles.forEach(file => {
                if (nextPhotos.length >= availableSlots) {
                    skippedForLimit = true;
                    return;
                }

                if (!(file.type || '').startsWith('image/')) {
                    showToast(`"${file.name}" is not an image.`, 'warn');
                    return;
                }

                if (file.size > 5 * 1024 * 1024) {
                    showToast(`"${file.name}" exceeds the 5MB limit.`, 'warn');
                    return;
                }

                nextPhotos.push({
                    tempId: state.nextPendingReviewPhotoId++,
                    file,
                    previewUrl: URL.createObjectURL(file),
                });
            });

            if (skippedForLimit) {
                showToast('You can upload up to 5 photos per review.', 'warn');
            }

            state.pendingReviewPhotos = [
                ...getPendingReviewPhotos(),
                ...nextPhotos,
            ];

            input.value = '';
            renderReviewSheet();
            syncReviewSheetSaveState();
        });

        reviewSheet.addEventListener('click', event => {
            const voteButton = event.target.closest('.js-profile-vote-btn');
            if (voteButton) {
                submitProfileReviewVote(voteButton);
                return;
            }

            const menuButton = event.target.closest('#review-sheet-menu-button');
            if (menuButton) {
                if (!isOwnProfile) return;
                event.stopPropagation();
                const { dropdown } = getReviewSheetMenuElements();
                setReviewSheetMenuOpen(dropdown?.hidden !== false);
                return;
            }

            const starButton = event.target.closest('.js-sheet-star');
            if (starButton) {
                if (!isOwnProfile) return;
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
                if (!isOwnProfile) return;
                setReviewSheetMenuOpen(false);
                setReviewSheetMode('edit');
                return;
            }

            if (event.target.closest('.js-sheet-header-delete')) {
                if (!isOwnProfile) return;
                setReviewSheetMenuOpen(false);
                setReviewSheetMode('confirm_delete');
                return;
            }

            const deletePhotoButton = event.target.closest('.js-sheet-delete-photo');
            if (deletePhotoButton) {
                if (!isOwnProfile) return;
                const photoId = Number(deletePhotoButton.dataset.photoId);
                if (!Number.isFinite(photoId)) return;

                if (!state.pendingDeletePhotoIds.includes(photoId)) {
                    state.pendingDeletePhotoIds.push(photoId);
                }
                renderReviewSheet();
                syncReviewSheetSaveState();
                return;
            }

            const deletePendingPhotoButton = event.target.closest('.js-sheet-delete-pending-photo');
            if (deletePendingPhotoButton) {
                if (!isOwnProfile) return;
                const tempId = Number(deletePendingPhotoButton.dataset.tempId);
                const nextPendingPhotos = [];

                getPendingReviewPhotos().forEach(photo => {
                    if (photo.tempId === tempId) {
                        URL.revokeObjectURL(photo.previewUrl);
                        return;
                    }
                    nextPendingPhotos.push(photo);
                });

                state.pendingReviewPhotos = nextPendingPhotos;
                renderReviewSheet();
                syncReviewSheetSaveState();
                return;
            }

            const addPhotoButton = event.target.closest('.js-sheet-add-photo');
            if (addPhotoButton) {
                if (!isOwnProfile) return;
                const input = reviewSheetBody.querySelector('.js-sheet-photo-input');
                input?.click();
                return;
            }

            if (event.target.closest('.js-sheet-cancel-edit')) {
                setReviewSheetMode('view');
                return;
            }

            if (event.target.closest('.js-sheet-save')) {
                if (!isOwnProfile) return;
                if (!hasPendingReviewChanges()) return;
                saveActiveReview();
                return;
            }

            if (event.target.closest('.js-sheet-cancel-delete')) {
                setReviewSheetMode('view');
                return;
            }

            if (event.target.closest('.js-sheet-confirm-delete')) {
                if (!isOwnProfile) return;
                deleteActiveReview();
            }
        });
    }

    function setReviewSheetMode(mode) {
        if (!isOwnProfile && mode !== 'view') return;
        if (state.reviewSheetMode === 'edit' && mode !== 'edit') {
            clearPendingReviewPhotos();
        }
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
    setupFavoriteActions();
    setupReviewSheet();
    setActiveTab('reviews');
});
