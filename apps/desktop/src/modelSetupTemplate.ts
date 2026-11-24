import { t } from "./i18n.ts";
export const modelSetupTemplate = `<header><button type="button" data-back>← ${t("model.allServices")}</button><h2>${t("onboard.pickService")}</h2><button type="button" data-close aria-label="${t("model.close")}">×</button></header>
 <section data-services><div class="model-services"></div></section>
 <form data-editor hidden autocomplete="off">
 <p class="model-destination"></p>
 <label>${t("model.baseUrl")}<input name="endpoint" type="url" spellcheck="false" placeholder="https://…"></label>
 <label data-protocol>${t("model.protocol")}<select name="protocol"><option value="openai-completions">${t("model.openaiCompatible")}</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">${t("model.claudeCompatible")}</option><option value="google-generative-ai">${t("model.geminiNative")}</option></select></label>
 <section class="model-key"><label><span data-key-label>API Key</span><input name="secret" type="password" autocomplete="new-password" spellcheck="false" placeholder="${t("model.newKey")}"></label><p data-key-status role="status"></p>
 <div class="model-actions"><button type="button" data-save-key>${t("model.saveKey")}</button><button type="button" data-clear-key hidden>${t("model.clearKey")}</button></div>
 <div data-confirm-clear hidden>${t("model.clearWarn")}<button type="button" data-confirm>${t("model.confirmClear")}</button><button type="button" data-keep>${t("model.keep")}</button></div></section>
 <p data-next-action role="status" hidden></p>
 <label>${t("model.chatModel")}<input name="chat-model" list="setup-chat-models" spellcheck="false" placeholder="${t("model.chatModelHint")}"></label>
 <datalist id="setup-chat-models"></datalist>
 <div class="model-actions"><button type="button" data-models>${t("model.fetchList")}</button><small data-list-note>${t("model.typeName")}</small></div>
 <details><summary>${t("model.moreSummary")}</summary>
 <label>${t("model.visionModel")}<input name="vision-model" list="setup-chat-models" spellcheck="false" placeholder="${t("model.visionHint")}"></label>
 <div class="switch-row"><span>${t("model.customCanSee")}</span><input type="checkbox" name="can-see" role="switch" aria-label="${t("model.customCanSee")}" class="slide-switch"></div>
 <label>${t("model.contextSize")}<input name="context-size" type="number" min="256" max="16000000"></label></details>
 <output data-result role="status"></output>
 <small>${t("model.testNote")}</small>
 <footer><button type="button" data-test>${t("model.testUse")}</button><button type="button" data-cancel>${t("common.return")}</button></footer></form>`;
