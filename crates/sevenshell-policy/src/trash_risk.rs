//! What a trash action could do, before it runs.
//!
//! Most of the trash reads: listing it, and moving an entry back out of it, put nothing at risk —
//! a restore only fills a name that was empty, and a name that was taken is refused rather than
//! overwritten. The two actions that destroy are `remove` (one entry, gone for good) and `empty`
//! (everything, gone for good), and both are `Destructive` like the workbench power verbs: the
//! strictest-layer rule raises destructive verdicts to at least a question, so the matrix can
//! never be configured to empty a trash unattended.
//!
//! The shape is the workbench gate's on purpose — a fixed verb with no command line behind it for
//! anybody to have read — and an unknown verb is `Catastrophic`, never run.

use sevenshell_types::{RiskAssessment, RiskLevel, RiskReason};

/// Classifies one trash action.
pub fn trash_action(action: &str) -> RiskAssessment {
    let action = action.trim().to_ascii_lowercase();
    let verdict = match action.as_str() {
        "empty" => ("trash.empty", "risk.trash.empty", RiskLevel::Destructive),
        "remove" => ("trash.remove", "risk.trash.remove", RiskLevel::Destructive),
        _ => ("trash.unknown", "risk.trash.unknown", RiskLevel::Catastrophic),
    };
    RiskAssessment::from_reasons(vec![RiskReason::new(verdict.0, verdict.1, verdict.2)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use sevenshell_types::RiskLevel;

    #[test]
    fn both_destroying_verbs_are_destructive_and_name_their_rule() {
        for action in ["empty", "remove", "Empty", " REMOVE "] {
            let verdict = trash_action(action);
            assert_eq!(verdict.level, RiskLevel::Destructive, "{action} is destructive");
            assert!(verdict.needs_approval(), "{action} always asks a person");
        }
    }

    #[test]
    fn empty_and_remove_are_told_apart() {
        assert_eq!(trash_action("empty").reasons[0].rule_id, "trash.empty");
        assert_eq!(trash_action("remove").reasons[0].rule_id, "trash.remove");
    }

    #[test]
    fn an_unknown_verb_is_catastrophic() {
        let verdict = trash_action("restore");
        assert_eq!(verdict.level, RiskLevel::Catastrophic);
        assert!(verdict.needs_approval());
    }
}
