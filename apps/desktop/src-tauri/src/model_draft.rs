use crate::locale::t;
use crate::{
    companion::{Companion, Settings},
    credentials::{self, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
type R<T> = Result<T, String>;
pub fn service_info(service: &str) -> R<Value> {
    let providers: Value =
        serde_json::from_str(include_str!("../../../shared/modelServices.json")).unwrap();
    providers
        .get(service)
        .cloned()
        .ok_or(t("host.unknownService").into())
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub service: String,
    pub base_url: String,
    pub model: String,
    pub vision_model: String,
    pub can_see: bool,
    pub context_window: u32,
    pub protocol: String,
}
impl Draft {
    pub(super) fn normalized(mut self, model: bool) -> R<Self> {
        let info = service_info(&self.service)?;
        self.base_url = credentials::endpoint(&self.base_url)?;
        self.model = self.model.trim().into();
        self.vision_model = self.vision_model.trim().into();
        if model && self.model.is_empty() {
            return Err(t("host.enterModel").into());
        }
        if self.model.len() > 200
            || self.vision_model.len() > 200
            || self.model.chars().any(|c| c.is_control())
            || self.vision_model.chars().any(|c| c.is_control())
        {
            return Err(t("host.modelBad").into());
        }
        if !(256..=16_000_000).contains(&self.context_window) {
            return Err(t("host.contextRange").into());
        }
        if self.service != "custom" {
            self.protocol = info["protocol"].as_str().unwrap().into();
        }
        if ![
            "openai-completions",
            "openai-responses",
            "anthropic-messages",
            "google-generative-ai",
        ]
        .contains(&self.protocol.as_str())
        {
            return Err(t("host.pickProtocol").into());
        }
        Ok(self)
    }
    pub(super) fn binding(&self) -> String {
        credentials::binding(&self.service, &self.base_url)
    }
    pub(crate) fn from_settings(s: &Settings) -> Self {
        Self {
            service: s.service.clone(),
            base_url: s.base_url.clone(),
            model: s.model.clone(),
            vision_model: s.vision_model.clone(),
            can_see: s.can_see,
            context_window: s.context_window,
            protocol: if s.protocol.is_empty() {
                service_info(&s.service)
                    .ok()
                    .and_then(|v| v["protocol"].as_str().map(str::to_owned))
                    .unwrap_or_default()
            } else {
                s.protocol.clone()
            },
        }
    }
    pub(crate) fn install(&self, s: &mut Settings, reference: String) {
        s.service = self.service.clone();
        s.base_url = self.base_url.clone();
        s.model = self.model.clone();
        s.vision_model = self.vision_model.clone();
        s.can_see = self.can_see;
        s.context_window = self.context_window;
        s.protocol = self.protocol.clone();
        s.credential_ref = reference;
    }
    pub(super) fn legacy_binding(&self, state: &Companion) -> Option<String> {
        let active = state.settings.lock().unwrap();
        if active.service == self.service
            && active.credential_ref.is_empty()
            && credentials::endpoint(&active.base_url).ok().as_deref()
                == Some(self.base_url.as_str())
        {
            Some(credentials::binding(&active.service, &active.base_url))
        } else {
            None
        }
    }
    pub(super) fn key(&self, state: &Companion, reference: &str) -> R<String> {
        let id = if reference.is_empty() {
            self.legacy_binding(state).unwrap_or_else(|| self.binding())
        } else {
            self.binding()
        };
        Store::default().key(&id, reference)
    }
    pub(super) fn reference(&self, state: &Companion) -> R<String> {
        let store = Store::default();
        if let Some(r) = store.pending(&state.dir, &self.binding())? {
            return Ok(r);
        }
        let active = state.settings.lock().unwrap();
        if credentials::binding(&active.service, &active.base_url) == self.binding() {
            return Ok(active.credential_ref.clone());
        }
        Ok(String::new())
    }
}
