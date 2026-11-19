//! What a Compose project action could do, before it runs.
//!
//! The same shape as the container actions: by the time one of these is asked, the action is
//! already a fixed verb with a fixed argv. The words that read a project are safe; the words that
//! change one are `Caution`, and the sentence that explains `down` is the one that says the
//! containers will stop.

use sevenshell_types::{RiskAssessment, RiskLevel, RiskReason};

/// Classifies one Compose operation.
///
/// Unknown verbs are `Caution`, never `Safe`: a caller this table has not learned about should be
/// looked at, not waved through.
pub fn compose_action(action: &str) -> RiskAssessment {
    let action = action.trim().to_ascii_lowercase();
    let verdict = match action.as_str() {
        "list" | "ps" | "logs" => return RiskAssessment::safe(),
        "up" => ("compose.up", "risk.compose.up", RiskLevel::Caution),
        "restart" => ("compose.restart", "risk.compose.restart", RiskLevel::Caution),
        "down" => ("compose.down", "risk.compose.down", RiskLevel::Caution),
        "write-yaml" => ("compose.writeYaml", "risk.compose.writeYaml", RiskLevel::Caution),
        _ => ("compose.unknown", "risk.compose.unknown", RiskLevel::Caution),
    };
    RiskAssessment::from_reasons(vec![RiskReason::new(verdict.0, verdict.1, verdict.2)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_a_project_is_safe() {
        for action in ["list", "ps", "logs"] {
            let verdict = compose_action(action);
            assert_eq!(verdict.level, RiskLevel::Safe, "{action} should not be gated");
            assert!(!verdict.needs_approval());
        }
    }

    #[test]
    fn the_words_that_change_a_project_are_caution() {
        for action in ["up", "restart", "down", "write-yaml"] {
            assert_eq!(compose_action(action).level, RiskLevel::Caution, "{action}");
            assert!(
                !compose_action(action).needs_approval(),
                "{action} runs under the default matrix"
            );
        }
        assert_eq!(compose_action("down").reasons[0].rule_id, "compose.down");
        assert_eq!(compose_action("write-yaml").reasons[0].rule_id, "compose.writeYaml");
    }

    #[test]
    fn an_unknown_compose_verb_is_caution_not_safe() {
        assert_eq!(compose_action("deploy").level, RiskLevel::Caution);
    }
}
