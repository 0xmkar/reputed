// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ICreatorRegistry} from "../src/interfaces/ICreatorRegistry.sol";

/// For T1.9b (script/check-rollback.sh). Swallows a failed revoke, so the transaction succeeds and
/// only the nested frame reverts. That leaves the consensus node alone to undo the unfreeze, with no
/// failed top-level transaction doing it. Needs ISSUER_ROLE while it runs.
contract RollbackProbe {
    error ExpectedFailure();

    event Caught(bytes reason);

    function revokeAndCatch(ICreatorRegistry registry, address holder, int64 serial) external {
        (bool ok, bytes memory reason) =
            address(registry).call(abi.encodeCall(ICreatorRegistry.revokeCredential, (holder, serial)));
        if (ok) revert ExpectedFailure();
        emit Caught(reason);
    }
}
