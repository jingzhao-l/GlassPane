import XCTest
@testable import GlassPaneEngine

/// `RestorePipeline.plan`'s step-ordering comparator (P5 spec v5.0 §6.2).
///
/// The comparator at `RestorePipeline.swift:173-180` returned `false` whenever a step's
/// domain was absent from `computed`, so an unknown-domain step tied with **both** `a`
/// and `c` while `a < c` held — not a strict weak ordering. Swift's `sorted` is allowed
/// to trap on that, and where it does not, the position of a caller-supplied step is
/// arbitrary: the same plan shape read back in a different input order came out ordered
/// differently, and a restore plan's step order is what the probe side executes.
///
/// Unknown domains are reachable from the public surface: `plan(snapshotId:baselineDigest:
/// domains:steps:expectedStateDigest:)` takes `domains` and `steps` from the caller
/// (`restore`'s wire params), and `preconditions` naming a domain the probe never
/// exported are matched only "against declared domains" (:115-119).
final class Qoder20261019UnknownDomainOrderingTests: XCTestCase {

    private func step(_ domain: String, preconditions: [String] = []) -> RestoreStep {
        RestoreStep(
            domain: domain,
            checkpointRef: "gpz1-json-v1#\(domain)",
            preconditions: preconditions
        )
    }

    private func plan(domains: [String], steps: [RestoreStep]) throws -> RestorePlan {
        try XCTUnwrap(
            RestorePipeline.plan(
                snapshotId: "snap_0123456789ABCDEFGHJKMNPQRS",
                baselineDigest: "digest",
                domains: domains,
                steps: steps,
                expectedStateDigest: "state"
            )
        )
    }

    /// The documented sink: a step whose domain was never computed is not equivalent to
    /// every other step — it goes after the ordered ones, so its position does not
    /// depend on where it happened to sit in the input.
    func testStepWhoseDomainIsAbsentFromTheComputedOrderIsSunk() throws {
        let produced = try plan(domains: ["a", "c"], steps: [step("ghost"), step("a"), step("c")])
        XCTAssertEqual(
            produced.steps.map(\.domain), ["a", "c", "ghost"],
            "an unknown-domain step tied with both a and c, so its place was the input's accident"
        )
        // The domain list itself is untouched: sinking is about the steps, not about
        // pretending the probe exported a domain it never did.
        XCTAssertEqual(produced.domains, ["a", "c"])
    }

    /// Determinism, stated the way a caller can check it: every input permutation of the
    /// same step set produces the same plan. With the old comparator this is exactly the
    /// property that was not guaranteed (and the shape Swift's sort may trap on).
    func testEveryInputPermutationProducesTheSameStepOrder() throws {
        let inputs: [[String]] = [
            ["ghost", "a", "c"],
            ["a", "ghost", "c"],
            ["a", "c", "ghost"],
            ["ghost", "c", "a"],
            ["c", "ghost", "a"],
            ["c", "a", "ghost"],
        ]
        let orders = try inputs.map { domains in
            try plan(domains: ["a", "c"], steps: domains.map { step($0) }).steps.map(\.domain)
        }
        for (index, order) in orders.enumerated() {
            XCTAssertEqual(order, ["a", "c", "ghost"], "permutation \(inputs[index]) produced \(order)")
        }
    }

    /// Unknown domains sink *as a class* in a stated order, so two of them do not
    /// reintroduce the same equivalence hole at the tail.
    func testSeveralUnknownDomainsSinkInAStatedOrder() throws {
        let produced = try plan(
            domains: ["heap", "kvc", "objc"],
            steps: [step("kvc"), step("heap"), step("objc"), step("ghost-b"), step("ghost-a")]
        )
        XCTAssertEqual(produced.steps.map(\.domain), ["heap", "kvc", "objc", "ghost-a", "ghost-b"])
    }

    /// A precondition naming an undeclared domain is the other door to the same hole
    /// (:115-119 matches preconditions against declared domains only). The step whose
    /// own domain is unknown must not be allowed to float into the ordered region by
    /// declaring one.
    func testUnknownDomainStepWithKnownPreconditionStaysSunk() throws {
        let produced = try plan(
            domains: ["a", "c"],
            steps: [step("c"), step("a"), step("ghost", preconditions: ["a"])]
        )
        XCTAssertEqual(produced.steps.map(\.domain), ["a", "c", "ghost"])
    }

    /// Ordering among *known* domains is unchanged: the fix must not have reordered the
    /// dependency contract it already honoured.
    func testKnownDomainsKeepTheirDependencyOrder() throws {
        let produced = try plan(
            domains: ["heap", "objc"],
            steps: [step("heap", preconditions: ["objc"]), step("objc")]
        )
        XCTAssertEqual(produced.steps.map(\.domain), ["objc", "heap"], produced.domains.description)
    }

    /// Nothing was dropped on the way: sinking is not filtering, and a plan that quietly
    /// loses a caller's step would be a different dishonesty of the same family.
    func testSinkingKeepsEverySuppliedStep() throws {
        let produced = try plan(domains: ["a"], steps: [step("ghost"), step("a"), step("other-ghost")])
        XCTAssertEqual(Set(produced.steps.map(\.domain)), ["a", "ghost", "other-ghost"])
        XCTAssertEqual(produced.steps.count, 3)
    }

    // MARK: - the comparator itself, as a relation

    /// Transitivity (the half that was broken): with `a < c` and an unknown `x` that
    /// answered "not less than" to both, `x` was equivalent to `a` *and* to `c`, while
    /// `a` and `c` are not equivalent to each other — the relation is not a strict weak
    /// ordering, which is exactly what Swift's `sorted` is entitled to trap on.
    func testComparatorIsATransitiveStrictWeakOrderingOverAMixedSet() {
        let computed = ["a", "c", "m"]
        let less = RestorePipeline.stepOrder(computed: computed)
        let steps = [
            step("a"), step("c"), step("m"),
            step("ghost-a"), step("ghost-b"),
            // A step whose domain *is* computed but which also names an undeclared
            // precondition: still ordered by its own domain, never by the ghost edge.
            step("m", preconditions: ["not-a-domain"]),
        ]
        let allIndices = Array(steps.indices)

        for i in allIndices {
            XCTAssertFalse(less(steps[i], steps[i]), "irreflexive violated for \(steps[i].domain)")
        }
        for i in allIndices {
            for j in allIndices where j != i {
                XCTAssertFalse(less(steps[i], steps[j]) && less(steps[j], steps[i]),
                               "asymmetry violated for \(steps[i].domain)/\(steps[j].domain)")
            }
        }
        for i in allIndices {
            for j in allIndices where j != i {
                for k in allIndices where k != i && k != j {
                    if less(steps[i], steps[j]) && less(steps[j], steps[k]) {
                        XCTAssertTrue(less(steps[i], steps[k]),
                                      "transitivity violated: \(steps[i].domain) < \(steps[j].domain) < \(steps[k].domain)")
                    }
                    // Equivalence has to be transitive too — that is the clause the old
                    // `return false` broke: an unknown step was equivalent to *every*
                    // known step while those known steps are ordered against each other.
                    let equivalent = !less(steps[i], steps[j]) && !less(steps[j], steps[i])
                    if equivalent {
                        for l in allIndices where l != i && l != j {
                            if !less(steps[j], steps[l]) && !less(steps[l], steps[j]) {
                                XCTAssertTrue(!less(steps[i], steps[l]) && !less(steps[l], steps[i]),
                                              "equivalence is not transitive: \(steps[i].domain)~\(steps[j].domain)~\(steps[l].domain)")
                            }
                        }
                    }
                }
            }
        }
        // The equivalence classes themselves: the three unknown-domain steps are
        // mutually equivalent only when they are truly interchangeable, so with two
        // distinct unknown domains the relation must order them.
        XCTAssertTrue(less(steps[3], steps[4]), "ghost-a must precede ghost-b")
        XCTAssertFalse(less(steps[4], steps[3]))
    }

    /// The sunk class is ordered, not merely gathered: two unknown domains compare by
    /// `(domain, checkpointRef)`, so the plan does not depend on the order the caller
    /// happened to write them in.
    func testSunkClassIsOrderedAmongItself() {
        let less = RestorePipeline.stepOrder(computed: ["a"])
        XCTAssertTrue(less(step("alpha"), step("beta")))
        XCTAssertFalse(less(step("beta"), step("alpha")))
        XCTAssertTrue(less(step("same", checkpoint: "ref-a"), step("same", checkpoint: "ref-b")),
                      "equal domains break the tie on the checkpoint ref")
        XCTAssertTrue(less(step("a"), step("any-unknown")), "known domains never sink")
        XCTAssertTrue(less(step("a", preconditions: ["ghost"]), step("any-unknown")),
                      "a ghost *precondition* does not make a known step unknown")
    }

    private func step(_ domain: String, checkpoint: String) -> RestoreStep {
        RestoreStep(domain: domain, checkpointRef: checkpoint)
    }
}
