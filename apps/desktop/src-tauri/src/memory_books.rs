use crate::locale::t;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

const ENTRY: &str = "\n§\n";
const BOOKS: &str = "\n── 随伴的笔记 ──\n";
const HEADER: &str = "关于你\n";
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
pub struct Books {
    pub user: Vec<String>,
    pub notes: Vec<String>,
    #[serde(default)]
    pub authored: std::collections::BTreeSet<String>,
    #[serde(default)]
    pub profile: String,
    #[serde(default)]
    pub profile_migration: Option<ProfileMigration>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct ProfileMigration {
    pub entries: Vec<(usize, String)>,
    pub before: String,
    pub after: String,
    pub undone: bool,
}
#[derive(Clone, Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Book {
    User,
    Notes,
}
#[derive(Clone, Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Add,
    Patch,
    Remove,
}
#[derive(Clone, Deserialize, Debug)]
pub struct Operation {
    pub book: Book,
    pub action: Action,
    pub old_text: Option<String>,
    pub content: Option<String>,
    #[serde(default)]
    pub exact: bool,
}
impl Books {
    // Keep the undo receipt in the same atomic file as the migrated contents.
    pub(super) fn migrate_profile(&mut self) -> bool {
        if self.profile_migration.is_some() {
            return false;
        }
        let entries: Vec<_> = self
            .user
            .iter()
            .enumerate()
            .filter(|(_, s)| self.authored.contains(*s))
            .map(|(i, s)| (i, s.clone()))
            .collect();
        if entries.is_empty() {
            return false;
        }
        let before = self.profile.clone();
        let text = entries
            .iter()
            .map(|(_, s)| s.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        self.profile = if before.is_empty() {
            text
        } else {
            format!("{before}\n{text}")
        };
        self.user.retain(|s| !self.authored.contains(s));
        self.authored.clear();
        self.profile_migration = Some(ProfileMigration {
            entries,
            before,
            after: self.profile.clone(),
            undone: false,
        });
        true
    }
    pub(super) fn undo_profile_migration(&mut self) -> Result<(), String> {
        let receipt = self
            .profile_migration
            .as_mut()
            .filter(|r| !r.undone)
            .ok_or(t("host.noMigration"))?;
        if self.profile != receipt.after {
            return Err(t("host.migrationEdited").into());
        }
        self.profile = receipt.before.clone();
        for (i, text) in &receipt.entries {
            if !self.user.contains(text) {
                self.user.insert((*i).min(self.user.len()), text.clone());
            }
            self.authored.insert(text.clone());
        }
        receipt.undone = true;
        Ok(())
    }
    pub(super) fn redo_profile_migration(&mut self) -> Result<(), String> {
        let receipt = self
            .profile_migration
            .as_ref()
            .filter(|r| r.undone)
            .ok_or(t("host.migrated"))?;
        if self.profile != receipt.before {
            return Err(t("host.migrateEdited").into());
        }
        self.profile_migration = None;
        self.migrate_profile();
        Ok(())
    }
    pub fn used(items: &[String]) -> usize {
        items.join(ENTRY).chars().count()
    }
    pub fn user_text(&self) -> String {
        self.user
            .iter()
            .map(|s| {
                format!(
                    "- （{}）{s}",
                    if self.authored.contains(s) {
                        "用户写的"
                    } else {
                        "你记的"
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    pub fn notes_text(&self) -> String {
        self.notes
            .iter()
            .map(|s| format!("- {s}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
    pub fn decode(s: &str) -> Result<Self, String> {
        let (user, notes) = s
            .strip_prefix(HEADER)
            .and_then(|v| v.split_once(BOOKS))
            .ok_or("记忆文件格式异常")?;
        let entries = |v: &str| {
            if v.is_empty() {
                vec![]
            } else {
                v.split(ENTRY).map(str::to_owned).collect()
            }
        };
        Ok(Self {
            user: entries(user),
            notes: entries(notes),
            authored: Default::default(),
            ..Self::default()
        })
    }
    pub(super) fn edit(&mut self, op: &Operation, manual: bool) -> Result<(), String> {
        let entries = match op.book {
            Book::User => &mut self.user,
            Book::Notes => &mut self.notes,
        };
        let content = || {
            op.content
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or(t("host.entryEmpty"))
        };
        match op.action {
            Action::Add => {
                if manual && matches!(op.book, Book::User) {
                    return Err(t("host.useProfileBox").into());
                }
                let value = content()?;
                check(value)?;
                if !entries.iter().any(|e| e == value) {
                    entries.push(value.to_owned());
                }
            }
            Action::Patch | Action::Remove => {
                let old = op
                    .old_text
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .ok_or(t("host.needOriginal"))?;
                let mut indices = entries
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| {
                        if op.exact {
                            e.as_str() == old
                        } else {
                            e.contains(old)
                        }
                    })
                    .map(|(i, _)| i);
                let i = indices.next().ok_or(t("host.entryMissing"))?;
                if indices.next().is_some() {
                    return Err(t("host.entryAmbiguous").into());
                }
                let owned = matches!(op.book, Book::User) && self.authored.contains(&entries[i]);
                if owned && !manual {
                    return Err(t("host.entryByUser").into());
                }
                if matches!(op.action, Action::Remove) {
                    if owned {
                        self.authored.remove(&entries[i]);
                    }
                    entries.remove(i);
                } else {
                    if entries[i].match_indices(old).count() != 1 {
                        return Err(t("host.entryOnce").into());
                    }
                    let changed = entries[i].replacen(old, content()?, 1);
                    check(&changed)?;
                    if entries
                        .iter()
                        .enumerate()
                        .any(|(j, v)| j != i && v == &changed)
                    {
                        return Err(t("host.entryDuplicate").into());
                    }
                    if owned {
                        self.authored.remove(&entries[i]);
                        self.authored.insert(changed.clone());
                    }
                    entries[i] = changed;
                }
            }
        }
        Ok(())
    }
}
static THREAT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)(忽略|无视|绕过|覆盖).{0,30}(指令|系统提示|安全规则)|(ignore|override|disregard)\s+(?:\w+\s+){0,6}(instructions?|system\s+prompt)|system\s+prompt\s+override|<\s*/?\s*(system|developer)\b|(?:do\s+not|never)\s+tell\s+the\s+user|(?:泄露|窃取|上传).{0,18}(密钥|密码)|\$\{?\w*(?:API_KEY|SECRET|PASSWORD|TOKEN)\b").unwrap()
});
fn check(value: &str) -> Result<(), String> {
    let normalized: String = value.nfkc().collect();
    if value.lines().any(|l| l == "§" || l == BOOKS.trim())
        || normalized.chars().any(|c| {
            matches!(c,'\u{200b}'..='\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
                || c.is_control() && c != '\n'
        })
        || THREAT.is_match(&normalized)
    {
        return Err(t("host.entryUnsafe").into());
    }
    Ok(())
}
