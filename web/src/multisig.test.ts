import { test } from "node:test";
import assert from "node:assert/strict";
import { rightsOf, type Multisig } from "./multisig";

// The policy Sputnik DAO's testnet factory gives a new multisig: anyone may file, the council votes.
const ms: Multisig = {
  dao: "team.sputnikv2.testnet",
  bond: "1",
  members: ["a.testnet", "b.testnet", "viewer.testnet"],
  threshold: [1, 2],
  roles: [
    { name: "all", members: "everyone", permissions: ["*:AddProposal"] },
    { name: "council", members: ["a.testnet", "b.testnet"], permissions: ["*:Finalize", "*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove"] },
    { name: "voters", members: ["viewer.testnet"], permissions: ["call:VoteApprove"] },
  ],
};

test("council members may propose and vote", () => {
  assert.deepEqual(rightsOf(ms, "a.testnet"), { member: true, propose: true, approve: true, reject: true });
});

test("the open role does not make an outsider a member in Keel", () => {
  assert.deepEqual(rightsOf(ms, "stranger.testnet"), { member: false, propose: false, approve: false, reject: false });
});

test("a vote-only role can approve function calls but not file or reject", () => {
  assert.deepEqual(rightsOf(ms, "viewer.testnet"), { member: true, propose: false, approve: true, reject: false });
});

test("permissions for other proposal kinds do not count for vault calls", () => {
  const t: Multisig = { ...ms, roles: [{ name: "tx", members: ["c.testnet"], permissions: ["transfer:AddProposal", "policy:VoteApprove"] }] };
  assert.deepEqual(rightsOf(t, "c.testnet"), { member: true, propose: false, approve: false, reject: false });
});
