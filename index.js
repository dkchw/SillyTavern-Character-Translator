const MODULE_NAME = 'character_translator';
const EXTENSION_DIR = 'third-party/SillyTavern-Character-Translator';

const defaultSettings = Object.freeze({
    defaultLanguage: 'Japanese',
    defaultLanguageCustom: '',
    nameSuffix: ' [{lang}]',
    autoSwitch: true,
    customPromptInstructions: '',
    fields: {
        name: true,
        description: true,
        personality: true,
        scenario: true,
        first_mes: true,
        mes_example: true,
        alternate_greetings: true,
        creator_notes: false,
        system_prompt: true,
        post_history_instructions: true,
    },
});

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

async function translateText(text, fieldName, targetLanguage, customInstructions) {
    if (!text || typeof text !== 'string' || !text.trim()) {
        return text || '';
    }

    const { generateRaw } = SillyTavern.getContext();

    const extraGuidance = customInstructions?.trim()
        ? `\nADDITIONAL USER INSTRUCTIONS & GLOSSARY:\n${customInstructions.trim()}\n`
        : '';

    const systemPrompt = `You are a professional literary translator and character localization specialist.
Translate the provided character card field ("${fieldName}") into ${targetLanguage}.${extraGuidance}
CRITICAL INSTRUCTIONS:
1. Maintain the character's original voice, style, emotional tone, and nuances.
2. Preserve all Markdown, formatting, quotation marks, and line breaks.
3. DO NOT translate SillyTavern macro tags and control tokens. Keep them EXACTLY as they appear: {{char}}, {{user}}, {{original}}, <START>, <start>, <bot>, <user>, etc.
4. Output ONLY the raw translated text. Never provide any conversational intro, outro, notes, explanations, or quotes around the whole response.`;

    try {
        const result = await generateRaw({
            prompt: text,
            systemPrompt: systemPrompt,
            trimNames: false,
        });

        if (typeof result === 'string' && result.trim()) {
            return result.trim();
        }
        return text;
    } catch (err) {
        console.error(`[Character Translator] Error translating field "${fieldName}":`, err);
        toastr.warning(`Failed to translate ${fieldName}, keeping original.`);
        return text;
    }
}

async function performCharacterTranslation(charIndex, targetLanguage, nameSuffix, selectedFields, customInstructions, progressCallback) {
    const { characters, characterId, getRequestHeaders, getCharacters } = SillyTavern.getContext();
    if (isNaN(charIndex) || charIndex < 0 || charIndex >= characters.length) {
        charIndex = (typeof characterId === 'number' && characters[characterId]) ? characterId : 0;
    }
    const originalChar = characters[charIndex];
    if (!originalChar) {
        throw new Error(`Selected character (index ${charIndex}) not found. Available characters: ${characters?.length || 0}`);
    }

    const originalData = originalChar.data || originalChar;
    const avatarUrl = originalChar.avatar;

    progressCallback('Cloning character card...', 5);

    // 1. Duplicate character card via ST backend
    const dupResponse = await fetch('/api/characters/duplicate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatarUrl }),
    });

    if (!dupResponse.ok) {
        throw new Error(`Failed to duplicate character: ${dupResponse.statusText}`);
    }

    const dupData = await dupResponse.json();
    const newAvatarUrl = dupData.path; // e.g. "Albedo_1.png"

    progressCallback('Character cloned. Starting field translations...', 15);

    // Prepare fields to translate - automatically ignore blank / whitespace-only fields
    const candidateFields = [
        { key: 'name', label: 'Name', val: originalData.name || '' },
        { key: 'description', label: 'Description', val: originalData.description || '' },
        { key: 'personality', label: 'Personality', val: originalData.personality || '' },
        { key: 'scenario', label: 'Scenario', val: originalData.scenario || '' },
        { key: 'first_mes', label: 'First Message', val: originalData.first_mes || '' },
        { key: 'mes_example', label: 'Example Dialogue', val: originalData.mes_example || '' },
        { key: 'creator_notes', label: 'Creator Notes', val: originalData.creator_notes || '' },
        { key: 'system_prompt', label: 'System Prompt', val: originalData.system_prompt || '' },
        { key: 'post_history_instructions', label: 'Post History Instructions', val: originalData.post_history_instructions || '' },
    ];

    // Filter to selected fields that actually contain non-blank content
    const fieldsToProcess = candidateFields.filter(item => {
        if (!selectedFields[item.key]) return false;
        return typeof item.val === 'string' && item.val.trim().length > 0;
    });

    // Alternate Greetings - only process non-blank entries
    const rawGreetings = Array.isArray(originalData.alternate_greetings) ? originalData.alternate_greetings : [];
    let translatedGreetings = [...rawGreetings];
    const greetingsToProcess = selectedFields.alternate_greetings
        ? rawGreetings
            .map((text, idx) => ({ index: idx, text }))
            .filter(item => typeof item.text === 'string' && item.text.trim().length > 0)
        : [];

    const totalSteps = Math.max(1, fieldsToProcess.length + greetingsToProcess.length);
    let currentStep = 0;

    const translatedResults = {};

    for (const item of fieldsToProcess) {
        currentStep++;
        const pct = Math.round(15 + (currentStep / totalSteps) * 75);
        progressCallback(`Translating ${item.label} (${currentStep}/${totalSteps})...`, pct);

        if (item.key === 'name') {
            const rawTrans = await translateText(item.val, item.label, targetLanguage, customInstructions);
            const suffix = nameSuffix ? nameSuffix.replace('{lang}', targetLanguage) : '';
            translatedResults[item.key] = `${rawTrans}${suffix}`;
        } else {
            translatedResults[item.key] = await translateText(item.val, item.label, targetLanguage, customInstructions);
        }
    }

    for (const greetingItem of greetingsToProcess) {
        currentStep++;
        const pct = Math.round(15 + (currentStep / totalSteps) * 75);
        progressCallback(`Translating Alternate Greeting ${greetingItem.index + 1} (${currentStep}/${totalSteps})...`, pct);
        const transGreeting = await translateText(greetingItem.text, `Alternate Greeting ${greetingItem.index + 1}`, targetLanguage, customInstructions);
        translatedGreetings[greetingItem.index] = transGreeting;
    }

    progressCallback('Saving translated character data...', 92);

    // 2. Assemble new character data using FormData for /api/characters/edit
    const formData = new FormData();
    formData.append('avatar_url', newAvatarUrl);
    formData.append('ch_name', translatedResults.name || originalData.name || 'Translated Character');
    formData.append('description', translatedResults.description ?? (originalData.description || ''));
    formData.append('personality', translatedResults.personality ?? (originalData.personality || ''));
    formData.append('scenario', translatedResults.scenario ?? (originalData.scenario || ''));
    formData.append('first_mes', translatedResults.first_mes ?? (originalData.first_mes || ''));
    formData.append('mes_example', translatedResults.mes_example ?? (originalData.mes_example || ''));
    formData.append('creator_notes', translatedResults.creator_notes ?? (originalData.creator_notes || ''));
    formData.append('system_prompt', translatedResults.system_prompt ?? (originalData.system_prompt || ''));
    formData.append('post_history_instructions', translatedResults.post_history_instructions ?? (originalData.post_history_instructions || ''));
    formData.append('creator', originalData.creator || '');
    formData.append('character_version', originalData.character_version || '1.0');
    formData.append('talkativeness', originalData.extensions?.talkativeness ?? (originalData.talkativeness || 0.5));
    formData.append('tags', Array.isArray(originalData.tags) ? originalData.tags.join(', ') : (originalData.tags || ''));

    for (const greeting of translatedGreetings) {
        formData.append('alternate_greetings', greeting);
    }

    // Preserve custom extension properties
    const extensionsPayload = structuredClone(originalData.extensions || {});
    formData.append('extensions', JSON.stringify(extensionsPayload));

    // Send edit request with omitContentType: true so the browser sets the multipart/form-data boundary
    const editResponse = await fetch('/api/characters/edit', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });

    if (!editResponse.ok) {
        const errorText = await editResponse.text().catch(() => '');
        throw new Error(`Failed to update translated character: ${editResponse.statusText}${errorText ? ` (${errorText})` : ''}`);
    }

    progressCallback('Refreshing character list...', 98);
    await getCharacters();

    const freshChars = SillyTavern.getContext().characters;
    const newIndex = freshChars.findIndex(c => c.avatar === newAvatarUrl);
    progressCallback('Done!', 100);

    return {
        newIndex,
        newAvatarUrl,
        name: translatedResults.name || originalData.name,
    };
}

async function openTranslationModal() {
    const { characters, characterId, Popup, POPUP_TYPE, POPUP_RESULT, selectCharacterById, saveSettingsDebounced } = SillyTavern.getContext();
    const settings = getSettings();
    const currentCharId = characterId !== undefined ? characterId : 0;

    let charOptions = '';
    characters.forEach((char, idx) => {
        const charName = char.data?.name || char.name || `Character ${idx}`;
        const isSelected = idx === currentCharId ? 'selected' : '';
        charOptions += `<option value="${idx}" ${isSelected}>${charName}</option>`;
    });

    const isCustomLang = settings.defaultLanguage === 'custom';

    const modalHtml = `
    <div class="st-char-trans-modal">
        <div class="st-char-trans-header-box">
            <img id="st_trans_preview_img" class="st-char-trans-avatar-preview" src="/characters/${characters[currentCharId]?.avatar}" onerror="this.src='/img/five.png'" />
            <div class="st-char-trans-info">
                <label for="st_trans_char_select"><b>Select Character:</b></label>
                <select id="st_trans_char_select" class="text_pole">
                    ${charOptions}
                </select>
            </div>
        </div>

        <div>
            <label for="st_trans_target_lang"><b>Target Language:</b></label>
            <div style="display: flex; gap: 8px; margin-top: 4px;">
                <select id="st_trans_target_lang" class="text_pole" style="flex: 1;">
                    <option value="Japanese" ${settings.defaultLanguage === 'Japanese' ? 'selected' : ''}>Japanese (日本語)</option>
                    <option value="Spanish" ${settings.defaultLanguage === 'Spanish' ? 'selected' : ''}>Spanish (Español)</option>
                    <option value="French" ${settings.defaultLanguage === 'French' ? 'selected' : ''}>French (Français)</option>
                    <option value="German" ${settings.defaultLanguage === 'German' ? 'selected' : ''}>German (Deutsch)</option>
                    <option value="Chinese (Simplified)" ${settings.defaultLanguage === 'Chinese (Simplified)' ? 'selected' : ''}>Chinese Simplified (简体中文)</option>
                    <option value="Chinese (Traditional)" ${settings.defaultLanguage === 'Chinese (Traditional)' ? 'selected' : ''}>Chinese Traditional (繁體中文)</option>
                    <option value="Korean" ${settings.defaultLanguage === 'Korean' ? 'selected' : ''}>Korean (한국어)</option>
                    <option value="Russian" ${settings.defaultLanguage === 'Russian' ? 'selected' : ''}>Russian (Русский)</option>
                    <option value="Italian" ${settings.defaultLanguage === 'Italian' ? 'selected' : ''}>Italian (Italiano)</option>
                    <option value="Portuguese" ${settings.defaultLanguage === 'Portuguese' ? 'selected' : ''}>Portuguese (Português)</option>
                    <option value="Vietnamese" ${settings.defaultLanguage === 'Vietnamese' ? 'selected' : ''}>Vietnamese (Tiếng Việt)</option>
                    <option value="Arabic" ${settings.defaultLanguage === 'Arabic' ? 'selected' : ''}>Arabic (العربية)</option>
                    <option value="English" ${settings.defaultLanguage === 'English' ? 'selected' : ''}>English</option>
                    <option value="custom" ${isCustomLang ? 'selected' : ''}>-- Custom Language --</option>
                </select>
                <input id="st_trans_custom_lang" type="text" class="text_pole" value="${settings.defaultLanguageCustom || ''}" placeholder="Type language..." style="flex: 1; display: ${isCustomLang ? 'block' : 'none'};" />
            </div>
        </div>

        <div>
            <label for="st_trans_custom_prompt"><b>Custom Prompt Instructions / Glossary:</b></label>
            <textarea id="st_trans_custom_prompt" class="text_pole" rows="3" placeholder="e.g. Translate titles as Lord/Lady; preserve formal speech; maintain fictional terminology...">${settings.customPromptInstructions || ''}</textarea>
            <small class="notes">Additional prompt rules injected into the translation model for this character.</small>
        </div>

        <div>
            <label for="st_trans_suffix_input"><b>Name Suffix:</b></label>
            <input id="st_trans_suffix_input" type="text" class="text_pole" value="${settings.nameSuffix}" placeholder="e.g. [{lang}] or (Translated)" />
        </div>

        <div>
            <div class="st-char-trans-fields-header">
                <b>Fields to Translate:</b>
                <div class="st-char-trans-fields-actions">
                    <button type="button" id="st_trans_select_all_btn" class="st-char-trans-action-btn" title="Tick all fields">
                        <i class="fa-solid fa-check-double"></i> Select All
                    </button>
                    <button type="button" id="st_trans_deselect_all_btn" class="st-char-trans-action-btn" title="Untick all fields">
                        <i class="fa-solid fa-square"></i> Deselect All
                    </button>
                </div>
            </div>
            <div class="st-char-trans-fields-container" id="st_trans_fields_container">
                <label><input type="checkbox" id="field_name" ${settings.fields.name ? 'checked' : ''} /> Character Name <span id="badge_field_name" class="st-char-trans-blank-badge"></span></label>
                <label><input type="checkbox" id="field_desc" ${settings.fields.description ? 'checked' : ''} /> Description <span id="badge_field_desc" class="st-char-trans-blank-badge"></span></label>
                <label><input type="checkbox" id="field_personality" ${settings.fields.personality ? 'checked' : ''} /> Personality <span id="badge_field_personality" class="st-char-trans-blank-badge"></span></label>
                <label><input type="checkbox" id="field_scenario" ${settings.fields.scenario ? 'checked' : ''} /> Scenario <span id="badge_field_scenario" class="st-char-trans-blank-badge"></span></label>
                <label><input type="checkbox" id="field_first_mes" ${settings.fields.first_mes ? 'checked' : ''} /> First Message <span id="badge_field_first_mes" class="st-char-trans-blank-badge"></span></label>
                <label><input type="checkbox" id="field_mes_example" ${settings.fields.mes_example ? 'checked' : ''} /> Dialogue Examples <span id="badge_field_mes_example" class="st-char-trans-blank-badge"></span></label>
                <label><input type="checkbox" id="field_greetings" ${settings.fields.alternate_greetings ? 'checked' : ''} /> Alternate Greetings <span id="badge_field_greetings" class="st-char-trans-blank-badge"></span></label>
                <label><input type="checkbox" id="field_system_prompt" ${settings.fields.system_prompt ? 'checked' : ''} /> System Prompt <span id="badge_field_system_prompt" class="st-char-trans-blank-badge"></span></label>
                <label><input type="checkbox" id="field_post_history" ${settings.fields.post_history_instructions ? 'checked' : ''} /> Post-History Note <span id="badge_field_post_history" class="st-char-trans-blank-badge"></span></label>
                <label><input type="checkbox" id="field_creator_notes" ${settings.fields.creator_notes ? 'checked' : ''} /> Creator Notes <span id="badge_field_creator_notes" class="st-char-trans-blank-badge"></span></label>
            </div>
            <small class="notes" style="display: block; margin-top: 6px;"><i class="fa-solid fa-circle-info"></i> Blank fields are automatically ignored and skipped during translation.</small>
        </div>

        <div id="st_trans_progress_area" class="st-char-trans-progress-box">
            <div class="st-char-trans-status-text">
                <i class="fa-solid fa-spinner fa-spin"></i> <span id="st_trans_status_msg">Ready</span>
            </div>
            <div class="st-char-trans-progress-bar-bg">
                <div id="st_trans_bar_fill" class="st-char-trans-progress-bar-fill"></div>
            </div>
        </div>
    </div>
    `;

    const popup = new Popup(modalHtml, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Translate & Clone',
        cancelButton: 'Cancel',
        wide: true,
        allowVerticalScrolling: true,
    });

    setTimeout(() => {
        const dlg = $(popup.dlg);
        const charSelect = dlg.find('#st_trans_char_select');
        const previewImg = dlg.find('#st_trans_preview_img');
        const langSelect = dlg.find('#st_trans_target_lang');
        const customLangInput = dlg.find('#st_trans_custom_lang');
        const selectAllBtn = dlg.find('#st_trans_select_all_btn');
        const deselectAllBtn = dlg.find('#st_trans_deselect_all_btn');
        const fieldsContainer = dlg.find('#st_trans_fields_container');

        const updateBlankBadges = (charIdx) => {
            const currentChars = SillyTavern.getContext().characters;
            const charObj = currentChars[charIdx];
            const data = charObj?.data || charObj || {};

            const checkMap = {
                field_name: data.name,
                field_desc: data.description,
                field_personality: data.personality,
                field_scenario: data.scenario,
                field_first_mes: data.first_mes,
                field_mes_example: data.mes_example,
                field_greetings: (Array.isArray(data.alternate_greetings) && data.alternate_greetings.some(g => typeof g === 'string' && g.trim())) ? 'valid' : '',
                field_system_prompt: data.system_prompt,
                field_post_history: data.post_history_instructions,
                field_creator_notes: data.creator_notes,
            };

            for (const [id, val] of Object.entries(checkMap)) {
                const isBlank = !val || (typeof val === 'string' && !val.trim());
                const badge = dlg.find(`#badge_${id}`);
                if (isBlank) {
                    badge.text('(blank - will skip)').show();
                } else {
                    badge.text('').hide();
                }
            }
        };

        const initialIdx = Number(charSelect.val()) || currentCharId || 0;
        updateBlankBadges(initialIdx);

        charSelect.on('change', () => {
            const selectedIdx = Number(charSelect.val());
            const currentChars = SillyTavern.getContext().characters;
            const charObj = currentChars[selectedIdx];
            if (charObj?.avatar) {
                previewImg.attr('src', `/characters/${charObj.avatar}`);
            }
            updateBlankBadges(selectedIdx);
        });

        selectAllBtn.on('click', () => {
            fieldsContainer.find('input[type="checkbox"]').prop('checked', true);
        });

        deselectAllBtn.on('click', () => {
            fieldsContainer.find('input[type="checkbox"]').prop('checked', false);
        });

        langSelect.on('change', () => {
            if (langSelect.val() === 'custom') {
                customLangInput.show().focus();
            } else {
                customLangInput.hide();
            }
        });
    }, 100);

    const result = await popup.show();

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        const charSelectEl = popup.dlg.querySelector('#st_trans_char_select');
        const targetLangEl = popup.dlg.querySelector('#st_trans_target_lang');
        const customLangEl = popup.dlg.querySelector('#st_trans_custom_lang');
        const suffixEl = popup.dlg.querySelector('#st_trans_suffix_input');
        const customPromptEl = popup.dlg.querySelector('#st_trans_custom_prompt');

        const rawCharIdx = charSelectEl ? Number(charSelectEl.value) : NaN;
        const selectedIdx = !isNaN(rawCharIdx) ? rawCharIdx : (currentCharId ?? 0);

        const targetLang = targetLangEl?.value || 'Japanese';
        const customLang = customLangEl?.value?.trim() || '';
        const effectiveTarget = targetLang === 'custom' ? (customLang || 'Japanese') : targetLang;
        const suffix = suffixEl?.value ?? ' [{lang}]';
        const customPrompt = customPromptEl?.value ?? '';

        const selectedFields = {
            name: !!popup.dlg.querySelector('#field_name')?.checked,
            description: !!popup.dlg.querySelector('#field_desc')?.checked,
            personality: !!popup.dlg.querySelector('#field_personality')?.checked,
            scenario: !!popup.dlg.querySelector('#field_scenario')?.checked,
            first_mes: !!popup.dlg.querySelector('#field_first_mes')?.checked,
            mes_example: !!popup.dlg.querySelector('#field_mes_example')?.checked,
            alternate_greetings: !!popup.dlg.querySelector('#field_greetings')?.checked,
            system_prompt: !!popup.dlg.querySelector('#field_system_prompt')?.checked,
            post_history_instructions: !!popup.dlg.querySelector('#field_post_history')?.checked,
            creator_notes: !!popup.dlg.querySelector('#field_creator_notes')?.checked,
        };

        // Persist settings
        settings.defaultLanguage = targetLang;
        settings.defaultLanguageCustom = customLang;
        settings.nameSuffix = suffix;
        settings.customPromptInstructions = customPrompt;
        settings.fields = selectedFields;
        saveSettingsDebounced();

        const progressToast = toastr.info('Cloning and translating character... Please wait.', 'Character Translator', {
            timeOut: 0,
            extendedTimeOut: 0,
            closeButton: false,
        });

        try {
            const translationResult = await performCharacterTranslation(
                selectedIdx,
                effectiveTarget,
                suffix,
                selectedFields,
                customPrompt,
                (statusText, pct) => {
                    toastr.clear(progressToast);
                    toastr.info(`${statusText} (${pct}%)`, 'Translating Character', { timeOut: 3000 });
                }
            );

            toastr.clear();
            toastr.success(`Character "${translationResult.name}" successfully translated into ${effectiveTarget}!`, 'Translation Complete');

            if (settings.autoSwitch && translationResult.newIndex !== -1) {
                await selectCharacterById(translationResult.newIndex);
            }
        } catch (error) {
            toastr.clear();
            console.error('[Character Translator] Fatal translation error:', error);
            toastr.error(`Translation failed: ${error.message}`, 'Error');
        }
    }
}

// Extension Initialization
(async function init() {
    const { renderExtensionTemplateAsync, saveSettingsDebounced, eventSource, eventTypes, SlashCommandParser, SlashCommand } = SillyTavern.getContext();

    // 1. Render Extension Settings Drawer
    try {
        const settings = getSettings();
        const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_DIR, 'settings', settings);
        $('#extensions_settings').append(settingsHtml);

        const defaultLangSel = $('#st_char_trans_default_lang');
        const customLangInp = $('#st_char_trans_custom_lang');

        defaultLangSel.val(settings.defaultLanguage).on('change', function () {
            settings.defaultLanguage = $(this).val();
            customLangInp.toggle(settings.defaultLanguage === 'custom');
            saveSettingsDebounced();
        });
        customLangInp.val(settings.defaultLanguageCustom || '').on('input', function () {
            settings.defaultLanguageCustom = $(this).val();
            saveSettingsDebounced();
        });
        customLangInp.toggle(settings.defaultLanguage === 'custom');

        $('#st_char_trans_custom_prompt').val(settings.customPromptInstructions || '').on('input', function () {
            settings.customPromptInstructions = $(this).val();
            saveSettingsDebounced();
        });

        $('#st_char_trans_open_btn').on('click', openTranslationModal);

        $('#st_char_trans_name_suffix').val(settings.nameSuffix).on('input', function () {
            settings.nameSuffix = $(this).val();
            saveSettingsDebounced();
        });
        $('#st_char_trans_auto_switch').prop('checked', settings.autoSwitch).on('change', function () {
            settings.autoSwitch = $(this).is(':checked');
            saveSettingsDebounced();
        });
    } catch (e) {
        console.error('[Character Translator] Failed to render settings template:', e);
    }

    // 2. Add quick button in Character Management menu
    const attachQuickButton = () => {
        const charButtons = $('#rm_character_import');
        if (charButtons.length && !$('#st_char_trans_quick_btn').length) {
            const btn = $(`
                <div id="st_char_trans_quick_btn" class="menu_button fa-solid fa-language" title="Translate & Clone Character" style="cursor: pointer;"></div>
            `);
            btn.on('click', openTranslationModal);
            charButtons.after(btn);
        }
    };

    if (eventSource && eventTypes) {
        eventSource.on(eventTypes.APP_READY, attachQuickButton);
    }
    attachQuickButton();

    // 3. Register Slash Command
    try {
        if (SlashCommandParser && SlashCommand) {
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'translate-character',
                aliases: ['translatechar', 'clonetranslate'],
                helpString: 'Opens the Character Translator modal to clone and translate a character.',
                callback: async () => {
                    openTranslationModal();
                    return 'Character Translator opened.';
                },
            }));
        }
    } catch (e) {
        console.debug('[Character Translator] Slash command registration error:', e);
    }
})();
