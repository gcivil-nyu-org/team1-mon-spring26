(function () {
    const LANGUAGES = [
        { code: 'af', name: 'Afrikaans' },
        { code: 'sq', name: 'Albanian' },
        { code: 'am', name: 'Amharic' },
        { code: 'ar', name: 'Arabic' },
        { code: 'hy', name: 'Armenian' },
        { code: 'az', name: 'Azerbaijani' },
        { code: 'eu', name: 'Basque' },
        { code: 'be', name: 'Belarusian' },
        { code: 'bn', name: 'Bengali' },
        { code: 'bs', name: 'Bosnian' },
        { code: 'bg', name: 'Bulgarian' },
        { code: 'ca', name: 'Catalan' },
        { code: 'ceb', name: 'Cebuano' },
        { code: 'zh-CN', name: 'Chinese (Simplified)' },
        { code: 'zh-TW', name: 'Chinese (Traditional)' },
        { code: 'co', name: 'Corsican' },
        { code: 'hr', name: 'Croatian' },
        { code: 'cs', name: 'Czech' },
        { code: 'da', name: 'Danish' },
        { code: 'nl', name: 'Dutch' },
        { code: 'eo', name: 'Esperanto' },
        { code: 'et', name: 'Estonian' },
        { code: 'fi', name: 'Finnish' },
        { code: 'fr', name: 'French' },
        { code: 'fy', name: 'Frisian' },
        { code: 'gl', name: 'Galician' },
        { code: 'ka', name: 'Georgian' },
        { code: 'de', name: 'German' },
        { code: 'el', name: 'Greek' },
        { code: 'gu', name: 'Gujarati' },
        { code: 'ht', name: 'Haitian Creole' },
        { code: 'ha', name: 'Hausa' },
        { code: 'haw', name: 'Hawaiian' },
        { code: 'he', name: 'Hebrew' },
        { code: 'hi', name: 'Hindi' },
        { code: 'hmn', name: 'Hmong' },
        { code: 'hu', name: 'Hungarian' },
        { code: 'is', name: 'Icelandic' },
        { code: 'ig', name: 'Igbo' },
        { code: 'id', name: 'Indonesian' },
        { code: 'ga', name: 'Irish' },
        { code: 'it', name: 'Italian' },
        { code: 'ja', name: 'Japanese' },
        { code: 'jv', name: 'Javanese' },
        { code: 'kn', name: 'Kannada' },
        { code: 'kk', name: 'Kazakh' },
        { code: 'km', name: 'Khmer' },
        { code: 'rw', name: 'Kinyarwanda' },
        { code: 'ko', name: 'Korean' },
        { code: 'ku', name: 'Kurdish' },
        { code: 'ky', name: 'Kyrgyz' },
        { code: 'lo', name: 'Lao' },
        { code: 'la', name: 'Latin' },
        { code: 'lv', name: 'Latvian' },
        { code: 'lt', name: 'Lithuanian' },
        { code: 'lb', name: 'Luxembourgish' },
        { code: 'mk', name: 'Macedonian' },
        { code: 'mg', name: 'Malagasy' },
        { code: 'ms', name: 'Malay' },
        { code: 'ml', name: 'Malayalam' },
        { code: 'mt', name: 'Maltese' },
        { code: 'mi', name: 'Maori' },
        { code: 'mr', name: 'Marathi' },
        { code: 'mn', name: 'Mongolian' },
        { code: 'my', name: 'Myanmar (Burmese)' },
        { code: 'ne', name: 'Nepali' },
        { code: 'no', name: 'Norwegian' },
        { code: 'ny', name: 'Nyanja (Chichewa)' },
        { code: 'or', name: 'Odia (Oriya)' },
        { code: 'ps', name: 'Pashto' },
        { code: 'fa', name: 'Persian' },
        { code: 'pl', name: 'Polish' },
        { code: 'pt', name: 'Portuguese' },
        { code: 'pa', name: 'Punjabi' },
        { code: 'ro', name: 'Romanian' },
        { code: 'ru', name: 'Russian' },
        { code: 'sm', name: 'Samoan' },
        { code: 'gd', name: 'Scots Gaelic' },
        { code: 'sr', name: 'Serbian' },
        { code: 'st', name: 'Sesotho' },
        { code: 'sn', name: 'Shona' },
        { code: 'sd', name: 'Sindhi' },
        { code: 'si', name: 'Sinhala (Sinhalese)' },
        { code: 'sk', name: 'Slovak' },
        { code: 'sl', name: 'Slovenian' },
        { code: 'so', name: 'Somali' },
        { code: 'es', name: 'Spanish' },
        { code: 'su', name: 'Sundanese' },
        { code: 'sw', name: 'Swahili' },
        { code: 'sv', name: 'Swedish' },
        { code: 'tl', name: 'Tagalog (Filipino)' },
        { code: 'tg', name: 'Tajik' },
        { code: 'ta', name: 'Tamil' },
        { code: 'tt', name: 'Tatar' },
        { code: 'te', name: 'Telugu' },
        { code: 'th', name: 'Thai' },
        { code: 'tr', name: 'Turkish' },
        { code: 'tk', name: 'Turkmen' },
        { code: 'uk', name: 'Ukrainian' },
        { code: 'ur', name: 'Urdu' },
        { code: 'ug', name: 'Uyghur' },
        { code: 'uz', name: 'Uzbek' },
        { code: 'vi', name: 'Vietnamese' },
        { code: 'cy', name: 'Welsh' },
        { code: 'xh', name: 'Xhosa' },
        { code: 'yi', name: 'Yiddish' },
        { code: 'yo', name: 'Yoruba' },
        { code: 'zu', name: 'Zulu' },
    ];

    let currentLang = localStorage.getItem('nyc_lang') || null;
    let gtReady = false;

    function suppressGoogleBar() {
        let style = document.getElementById('gt-suppress');
        if (!style) {
            style = document.createElement('style');
            style.id = 'gt-suppress';
            document.head.appendChild(style);
        }
        style.textContent = `
            .goog-te-banner-frame, .skiptranslate, #goog-gt-tt,
            .goog-tooltip, .goog-tooltip-content,
            .goog-te-balloon-frame, .goog-te-ftab-frame { display: none !important; visibility: hidden !important; }
            body { top: 0 !important; position: static !important; }
        `;
    }

    function loadGoogleTranslate(callback) {
        if (gtReady) { callback(); return; }
        window.googleTranslateElementInit = function () {
            new google.translate.TranslateElement({ pageLanguage: 'en', autoDisplay: false }, 'gt-hidden-el');
            suppressGoogleBar();
            gtReady = true;
            setTimeout(callback, 500);
        };
        const s = document.createElement('script');
        s.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
        s.onerror = () => console.warn('Google Translate failed to load');
        document.head.appendChild(s);
    }

    function applyLanguage(code) {
        const select = document.querySelector('.goog-te-combo');
        if (!select) return;
        select.value = code;
        select.dispatchEvent(new Event('change'));
        suppressGoogleBar();
        localStorage.setItem('nyc_lang', code);
        currentLang = code;
        updateBtn();
    }

    function resetLanguage() {
        localStorage.removeItem('nyc_lang');
        currentLang = null;
        updateBtn();
        window.location.reload();
}

    function updateBtn() {
        const btn = document.getElementById('translate-btn');
        if (!btn) return;
        if (currentLang) {
            btn.style.color = 'var(--accent)';
            btn.style.borderColor = 'var(--accent)';
            btn.style.background = 'var(--accent-lt)';
        } else {
            btn.style.color = '';
            btn.style.borderColor = '';
            btn.style.background = '';
        }
    }

    function renderList(filter) {
        const list = document.getElementById('lang-list');
        if (!list) return;
        const q = (filter || '').toLowerCase();
        const filtered = q ? LANGUAGES.filter(l => l.name.toLowerCase().includes(q)) : LANGUAGES;

        if (!filtered.length) {
            list.innerHTML = '<div style="padding:12px;font-size:13px;color:var(--text-3);text-align:center;">No results</div>';
            return;
        }

        list.innerHTML = filtered.map(l => {
            const active = currentLang === l.code;
            return `<div class="search-result-item lang-item" data-code="${l.code}"
                style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;
                ${active ? 'background:var(--accent-lt);color:var(--accent);font-weight:600;' : ''}">
                <span>${l.name}</span>
                ${active ? '<span style="font-size:12px;">✓</span>' : ''}
            </div>`;
        }).join('');

        list.querySelectorAll('.lang-item').forEach(el => {
            el.addEventListener('click', () => {
                const code = el.dataset.code;
                loadGoogleTranslate(() => applyLanguage(code));
                closeModal();
            });
        });
    }

    function openModal() {
        const modal = document.getElementById('translate-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        const search = document.getElementById('lang-search');
        if (search) { search.value = ''; search.focus(); }
        renderList('');
    }

    function closeModal() {
        const modal = document.getElementById('translate-modal');
        if (modal) modal.style.display = 'none';
    }

    document.addEventListener('DOMContentLoaded', () => {
        // hidden div for Google Translate widget to attach to — must be in body
        const el = document.createElement('div');
        el.id = 'gt-hidden-el';
        el.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';
        document.body.appendChild(el);

        updateBtn();

        // restore saved language on load
        if (currentLang) {
            loadGoogleTranslate(() => applyLanguage(currentLang));
        }

        document.getElementById('translate-btn')?.addEventListener('click', openModal);
        document.getElementById('translate-modal-close')?.addEventListener('click', closeModal);
        document.getElementById('translate-modal')?.addEventListener('click', e => {
            if (e.target === e.currentTarget) closeModal();
        });
        document.getElementById('translate-reset-btn')?.addEventListener('click', () => {
            resetLanguage();
            closeModal();
        });
        document.getElementById('lang-search')?.addEventListener('input', e => {
            renderList(e.target.value);
        });
    });
})();