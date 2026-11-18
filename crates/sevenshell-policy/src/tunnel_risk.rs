//! What a forward could expose, before a port opens — here, or on the server.
//!
//! A local forward is the `ssh -L` shape: a listener on this machine whose traffic reaches a
//! destination on the far side. Opening one is `Caution` — it moves traffic, but only for the
//! person at this machine — until the listener binds an address that is not loopback, at which
//! point other machines can reach the far side through it. That is the one question the reference
//! product asks before opening a port, and it is `Destructive` here, which is the level the
//! default matrix answers with a stop for a person.
//!
//! A remote forward turns that around: the port opens on the *server*, and it is a window onto
//! this machine. Whoever can reach the server — everyone it is reachable by, which is why it is
//! running SSH at all — reaches the target on the user's own network with it. There is no address
//! that softens that: even a loopback bind on the server is open to every other process and every
//! other account on it, which for a shared server is the wider case already. So remote is
//! `Destructive` always, and the audit line names what is exposed: the target on this machine.
//!
//! `stop` takes the forward away from whoever was using it, which is `Caution`. A mode this table
//! has no rule for is `Catastrophic` and never runs.

use sevenshell_types::{RiskAssessment, RiskLevel, RiskReason};

/// Classifies opening one forward. `mode` is the forward's kind as the classifier sees it —
/// `local`, `dynamic` or `remote` — and `bind_host` is the address the listener would bind: here
/// for the first two, on the server for a remote one.
pub fn tunnel_open(mode: &str, bind_host: &str) -> RiskAssessment {
    let mode = mode.trim().to_ascii_lowercase();
    match mode.as_str() {
        "local" | "dynamic" => {
            if binds_this_machine_only(bind_host) {
                one("tunnel.open", "risk.tunnel.open", RiskLevel::Caution)
            } else {
                one("tunnel.expose", "risk.tunnel.expose", RiskLevel::Destructive)
            }
        }
        "remote" => one("tunnel.remote", "risk.tunnel.remote", RiskLevel::Destructive),
        _ => one("tunnel.unknown", "risk.tunnel.unknown", RiskLevel::Catastrophic),
    }
}

/// Classifies stopping one forward.
pub fn tunnel_stop() -> RiskAssessment {
    one("tunnel.stop", "risk.tunnel.stop", RiskLevel::Caution)
}

fn one(rule_id: &str, label_key: &str, level: RiskLevel) -> RiskAssessment {
    RiskAssessment::from_reasons(vec![RiskReason::new(rule_id, label_key, level)])
}

/// Whether an address answers this machine only.
///
/// A loopback address or the name `localhost` does; anything else — an empty field, an interface
/// address, the all-interfaces wildcard — does not, and an address that cannot be read is treated
/// as the wider case, because the mistaken direction here is exposing a port, not closing one.
fn binds_this_machine_only(bind_host: &str) -> bool {
    let host = bind_host.trim();
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sevenshell_types::{PolicyAction, PolicyRule, RiskLevel};

    #[test]
    fn a_loopback_forward_is_caution_and_names_its_rule() {
        for host in ["127.0.0.1", "localhost", "::1", "127.9.9.9"] {
            let verdict = tunnel_open("local", host);
            assert_eq!(verdict.level, RiskLevel::Caution, "{host}");
            assert!(!verdict.needs_approval(), "{host} runs unattended by default");
            assert_eq!(verdict.reasons[0].rule_id, "tunnel.open", "{host}");
        }
    }

    #[test]
    fn a_forward_that_other_machines_can_reach_stops_for_a_person() {
        for host in ["0.0.0.0", "192.168.1.10", "", "not-an-address"] {
            let verdict = tunnel_open("local", host);
            assert_eq!(verdict.level, RiskLevel::Destructive, "{host}");
            assert!(verdict.needs_approval(), "{host} asks before it binds");
            assert_eq!(verdict.reasons[0].rule_id, "tunnel.expose", "{host}");
            // The "Ask" the contract names is the default matrix's answer to this level.
            assert_eq!(
                PolicyRule::default().action_for(verdict.level),
                PolicyAction::Ask,
                "{host}"
            );
        }
    }

    #[test]
    fn a_remote_forward_stops_for_a_person_wherever_it_binds() {
        // The bind address is the server's, and no address on the server softens what the forward
        // is: a window onto this machine that everyone who reaches the server can look through.
        for host in ["127.0.0.1", "localhost", "::1", "0.0.0.0", ""] {
            let verdict = tunnel_open("remote", host);
            assert_eq!(verdict.level, RiskLevel::Destructive, "{host}");
            assert!(verdict.needs_approval(), "{host} asks before the server's port opens");
            assert_eq!(verdict.reasons[0].rule_id, "tunnel.remote", "{host}");
            assert_eq!(
                PolicyRule::default().action_for(verdict.level),
                PolicyAction::Ask,
                "{host}"
            );
        }
    }

    #[test]
    fn a_mode_without_a_rule_is_catastrophic_and_asked_about() {
        let verdict = tunnel_open("socks", "127.0.0.1");
        assert_eq!(verdict.level, RiskLevel::Catastrophic);
        assert!(verdict.needs_approval(), "nothing here may run unattended");
        assert_eq!(verdict.reasons[0].rule_id, "tunnel.unknown");
    }

    #[test]
    fn stopping_is_caution_and_names_its_rule() {
        let verdict = tunnel_stop();
        assert_eq!(verdict.level, RiskLevel::Caution);
        assert_eq!(verdict.reasons[0].rule_id, "tunnel.stop");
    }

    #[test]
    fn the_mode_is_read_without_regard_to_case_or_padding() {
        assert_eq!(tunnel_open("  DYNAMIC ", "127.0.0.1").level, RiskLevel::Caution);
    }
}
