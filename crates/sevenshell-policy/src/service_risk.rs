//! What a service action could do, before it runs.
//!
//! The system panel lists systemd units; the actions on one are the same shape as the container,
//! workbench and process gates — a fixed verb with a fixed command behind it — decided here rather
//! than by the command classifier, because there is no command line for anybody to have read.
//!
//! `stop` can take a database, a web server or a tunnel away from whoever is using it, so it is
//! `Destructive`; `restart` interrupts the same thing for a moment, which is `Caution`. An unknown
//! verb is `Catastrophic` and never runs: this table has no command for it.

use sevenshell_types::{RiskAssessment, RiskLevel, RiskReason};

/// Classifies one service action.
pub fn service_action(action: &str) -> RiskAssessment {
    let action = action.trim().to_ascii_lowercase();
    let verdict = match action.as_str() {
        "start" | "enable" | "disable" => ("service.change", "risk.service.change", RiskLevel::Caution),
        "restart" | "reload" => ("service.restart", "risk.service.restart", RiskLevel::Caution),
        "stop" => ("service.stop", "risk.service.stop", RiskLevel::Destructive),
        _ => ("service.unknown", "risk.service.unknown", RiskLevel::Catastrophic),
    };
    RiskAssessment::from_reasons(vec![RiskReason::new(verdict.0, verdict.1, verdict.2)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use sevenshell_types::RiskLevel;

    #[test]
    fn stopping_is_destructive_and_names_its_rule() {
        let verdict = service_action("stop");
        assert_eq!(verdict.level, RiskLevel::Destructive);
        assert!(verdict.needs_approval());
        assert_eq!(verdict.reasons[0].rule_id, "service.stop");
    }

    #[test]
    fn starting_and_restarting_are_caution_each_with_their_own_rule() {
        for action in ["start", "restart", "reload", "enable", "disable"] {
            let verdict = service_action(action);
            assert_eq!(verdict.level, RiskLevel::Caution, "{action}");
        }
        assert_eq!(service_action("restart").reasons[0].rule_id, "service.restart");
        assert_eq!(service_action("start").reasons[0].rule_id, "service.change");
    }

    #[test]
    fn an_unknown_verb_is_catastrophic_and_asked_about() {
        let verdict = service_action("mask");
        assert_eq!(verdict.level, RiskLevel::Catastrophic);
        assert!(verdict.needs_approval(), "nothing here may run unattended");
    }

    #[test]
    fn the_verb_is_read_without_regard_to_case_or_padding() {
        assert_eq!(service_action("  STOP ").level, RiskLevel::Destructive);
    }
}
