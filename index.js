import {
    eventSource,
    event_types,
    getRequestHeaders,
    characters,
    this_chid,
    getCharacters,
    selectCharacterById,
    generateRaw,
    renderExtensionTemplateAsync,
    extension_settings,
    saveSettingsDebounced,
    Popup,
    POPUP_TYPE,
    POPUP_RESULT,
    SlashCommandParser,
    SlashCommand,
    SlashCommandArgument,
    ARGUMENT_TYPE,
} from '../../../script.js';

const MODULE_NAME = 'character_translator';
const EXTENSION_DIR = 'third-party/SillyTavern-Character-Translator';

const defaultSettings = Object.freeze({
    defaultLanguage: 'Japanese',
    nameSuffix: ' [{lang}]',
    autoSwitch: true,
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
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extension_settings[MODULE_NAME], key)) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

async function translateText(text, fieldName, targetLanguage) {
    if (!text || typeof text !== 'string' || !text.trim()) {
        return text || '';
    }

    const systemPrompt = `You are a professional literary translator and character localization specialist.
Translate the provided character card field ("${fieldName}") into ${targetLanguage}.
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

async function performCharacterTranslation(charIndex, targetLanguage, nameSuffix, selectedFields, progressCallback) {
    const originalChar = characters[charIndex];
    if (!originalChar) {
        throw new Error('Selected character not found.');
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

    // Prepare fields to translate
    const fieldsToProcess = [];
    if (selectedFields.name) fieldsToProcess.push({ key: 'name', label: 'Name', val: originalData.name || '' });
    if (selectedFields.description) fieldsToProcess.push({ key: 'description', label: 'Description', val: originalData.description || '' });
    if (selectedFields.personality) fieldsToProcess.push({ key: 'personality', label: 'Personality', val: originalData.personality || '' });
    if (selectedFields.scenario) fieldsToProcess.push({ key: 'scenario', label: 'Scenario', val: originalData.scenario || '' });
    if (selectedFields.first_mes) fieldsToProcess.push({ key: 'first_mes', label: 'First Message', val: originalData.first_mes || '' });
    if (selectedFields.mes_example) fieldsToProcess.push({ key: 'mes_example', label: 'Example Dialogue', val: originalData.mes_example || '' });
    if (selectedFields.creator_notes) fieldsToProcess.push({ key: 'creator_notes', label: 'Creator Notes', val: originalData.creator_notes || '' });
    if (selectedFields.system_prompt) fieldsToProcess.push({ key: 'system_prompt', label: 'System Prompt', val: originalData.system_prompt || '' });
    if (selectedFields.post_history_instructions) fieldsToProcess.push({ key: 'post_history_instructions', label: 'Post History Instructions', val: originalData.post_history_instructions || '' });

    const totalSteps = fieldsToProcess.length + (selectedFields.alternate_greetings && Array.isArray(originalData.alternate_greetings) ? originalData.alternate_greetings.length : 0) + 1;
    let currentStep = 0;

    const translatedResults = {};

    for (const item of fieldsToProcess) {
        currentStep++;
        const pct = Math.round(15 + (currentStep / totalSteps) * 75);
        progressCallback(`Translating ${item.label} (${currentStep}/${totalSteps})...`, pct);

        if (item.key === 'name') {
            const rawTrans = await translateText(item.val, item.label, targetLanguage);
            const suffix = nameSuffix ? nameSuffix.replace('{lang}', targetLanguage) : '';
            translatedResults[item.key] = `${rawTrans}${suffix}`;
        } else {
            translatedResults[item.key] = await translateText(item.val, item.label, targetLanguage);
        }
    }

    // Alternate Greetings
    let translatedGreetings = [];
    if (selectedFields.alternate_greetings && Array.isArray(originalData.alternate_greetings) && originalData.alternate_greetings.length > 0) {
        for (let i = 0; i < originalData.alternate_greetings.length; i++) {
            currentStep++;
            const pct = Math.round(15 + (currentStep / totalSteps) * 75);
            progressCallback(`Translating Alternate Greeting ${i + 1}/${originalData.alternate_greetings.length}...`, pct);
            const transGreeting = await translateText(originalData.alternate_greetings[i], `Alternate Greeting ${i + 1}`, targetLanguage);
            translatedGreetings.push(transGreeting);
        }
    } else if (Array.isArray(originalData.alternate_greetings)) {
        translatedGreetings = [...originalData.alternate_greetings];
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

    // Send edit request
    const editResponse = await fetch('/api/characters/edit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: formData,
    });

    if (!editResponse.ok) {
        throw new Error(`Failed to update translated character: ${editResponse.statusText}`);
    }

    progressCallback('Refreshing character list...', 98);
    await getCharacters();

    const newIndex = characters.findIndex(c => c.avatar === newAvatarUrl);
    progressCallback('Done!', 100);

    return {
        newIndex,
        newAvatarUrl,
        name: translatedResults.name || originalData.name,
    };
}

async function openTranslationModal() {
    const settings = getSettings();
    const currentCharId = this_chid !== undefined ? this_chid : 0;

    let charOptions = '';
    characters.forEach((char, idx) => {
        const charName = char.data?.name || char.name || `Character ${idx}`;
        const isSelected = idx === currentCharId ? 'selected' : '';
        charOptions += `<option value="${idx}" ${isSelected}>${charName}</option>`;
    });

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
                    <option value="custom">-- Custom Language --</option>
                </select>
                <input id="st_trans_custom_lang" type="text" class="text_pole" placeholder="Type language..." style="flex: 1; display: none;" />
            </div>
        </div>

        <div>
            <label for="st_trans_suffix_input"><b>Name Suffix:</b></label>
            <input id="st_trans_suffix_input" type="text" class="text_pole" value="${settings.nameSuffix}" placeholder="e.g. [{lang}] or (Translated)" />
        </div>

        <div>
            <b>Fields to Translate:</b>
            <div class="st-char-trans-fields-container">
                <label><input type="checkbox" id="field_name" ${settings.fields.name ? 'checked' : ''} /> Character Name</label>
                <label><input type="checkbox" id="field_desc" ${settings.fields.description ? 'checked' : ''} /> Description</label>
                <label><input type="checkbox" id="field_personality" ${settings.fields.personality ? 'checked' : ''} /> Personality</label>
                <label><input type="checkbox" id="field_scenario" ${settings.fields.scenario ? 'checked' : ''} /> Scenario</label>
                <label><input type="checkbox" id="field_first_mes" ${settings.fields.first_mes ? 'checked' : ''} /> First Message</label>
                <label><input type="checkbox" id="field_mes_example" ${settings.fields.mes_example ? 'checked' : ''} /> Dialogue Examples</label>
                <label><input type="checkbox" id="field_greetings" ${settings.fields.alternate_greetings ? 'checked' : ''} /> Alternate Greetings</label>
                <label><input type="checkbox" id="field_system_prompt" ${settings.fields.system_prompt ? 'checked' : ''} /> System Prompt</label>
                <label><input type="checkbox" id="field_post_history" ${settings.fields.post_history_instructions ? 'checked' : ''} /> Post-History Note</label>
                <label><input type="checkbox" id="field_creator_notes" ${settings.fields.creator_notes ? 'checked' : ''} /> Creator Notes</label>
            </div>
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

    // Handle popup events once rendered
    setTimeout(() => {
        const charSelect = $('#st_trans_char_select');
        const previewImg = $('#st_trans_preview_img');
        const langSelect = $('#st_trans_target_lang');
        const customLangInput = $('#st_trans_custom_lang');

        charSelect.on('change', () => {
            const selectedIdx = Number(charSelect.val());
            const charObj = characters[selectedIdx];
            if (charObj?.avatar) {
                previewImg.attr('src', `/characters/${charObj.avatar}`);
            }
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
        const selectedIdx = Number($('#st_trans_char_select').val());
        let targetLang = $('#st_trans_target_lang').val();
        if (targetLang === 'custom') {
            targetLang = $('#st_trans_custom_lang').val().trim() || 'Japanese';
        }
        const suffix = $('#st_trans_suffix_input').val();

        const selectedFields = {
            name: $('#field_name').is(':checked'),
            description: $('#field_desc').is(':checked'),
            personality: $('#field_personality').is(':checked'),
            scenario: $('#field_scenario').is(':checked'),
            first_mes: $('#field_first_mes').is(':checked'),
            mes_example: $('#field_mes_example').is(':checked'),
            alternate_greetings: $('#field_greetings').is(':checked'),
            system_prompt: $('#field_system_prompt').is(':checked'),
            post_history_instructions: $('#field_post_history').is(':checked'),
            creator_notes: $('#field_creator_notes').is(':checked'),
        };

        // Persist settings
        settings.defaultLanguage = targetLang;
        settings.nameSuffix = suffix;
        settings.fields = selectedFields;
        saveSettingsDebounced();

        // Run translation with blocking toast
        const progressToast = toastr.info('Cloning and translating character... Please wait.', 'Character Translator', {
            timeOut: 0,
            extendedTimeOut: 0,
            closeButton: false,
        });

        try {
            const translationResult = await performCharacterTranslation(
                selectedIdx,
                targetLang,
                suffix,
                selectedFields,
                (statusText, pct) => {
                    toastr.clear(progressToast);
                    toastr.info(`${statusText} (${pct}%)`, 'Translating Character', { timeOut: 3000 });
                }
            );

            toastr.clear();
            toastr.success(`Character "${translationResult.name}" successfully translated into ${targetLang}!`, 'Translation Complete');

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

jQuery(async () => {
    // 1. Render Extension Settings Drawer
    try {
        const settings = getSettings();
        const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_DIR, 'settings', settings);
        $('#extensions_settings').append(settingsHtml);

        $('#st_char_trans_open_btn').on('click', openTranslationModal);
        $('#st_char_trans_default_lang').val(settings.defaultLanguage).on('change', function () {
            settings.defaultLanguage = $(this).val();
            saveSettingsDebounced();
        });
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

    // 2. Add button in Character Management menu on APP_READY
    eventSource.on(event_types.APP_READY, () => {
        const charButtons = $('#rm_character_import');
        if (charButtons.length && !$('#st_char_trans_quick_btn').length) {
            const btn = $(`
                <div id="st_char_trans_quick_btn" class="menu_button fa-solid fa-language" title="Translate & Clone Character" style="cursor: pointer;"></div>
            `);
            btn.on('click', openTranslationModal);
            charButtons.after(btn);
        }
    });

    // 3. Register Slash Command
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'translate-character',
            aliases: ['translatechar', 'clonetranslate'],
            helpString: 'Opens the Character Translator modal to clone and translate a character.',
            callback: async () => {
                openTranslationModal();
                return 'Character Translator opened.';
            },
        }));
    } catch (e) {
        console.debug('[Character Translator] Slash command registration error:', e);
    }
});
