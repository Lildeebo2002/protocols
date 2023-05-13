// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2017 Loopring Technology Limited.
pragma solidity ^0.8.17;
pragma experimental ABIEncoderV2;

import "./WalletData.sol";
import "./GuardianLib.sol";
import "./LockLib.sol";
import "./Utils.sol";
import "./ApprovalLib.sol";

/// @title RecoverLib
/// @author Brecht Devos - <brecht@loopring.org>
library RecoverLib {
    using GuardianLib for Wallet;
    using LockLib for Wallet;
    using Utils for address;

    event Recovered(address newOwner);

    bytes32 public constant RECOVER_TYPEHASH =
        keccak256(
            "recover(address wallet,uint256 validUntil,address newOwner,address[] newGuardians)"
        );

    /// @dev Recover a wallet by setting a new owner and guardians.
    /// @param newOwner The new owner address to set.
    /// @param newGuardians The new guardians addresses to set.
    function recover(
        Wallet storage wallet,
        address newOwner,
        address[] calldata newGuardians
    ) external {
        require(wallet.owner != newOwner, "IS_SAME_OWNER");
        require(newOwner.isValidWalletOwner(), "INVALID_NEW_WALLET_OWNER");

        wallet.owner = newOwner;
        wallet.setLock(address(this), false);

        if (newGuardians.length > 0) {
            for (uint i = 0; i < newGuardians.length; i++) {
                require(
                    newGuardians[i] != newOwner,
                    "INVALID_NEW_WALLET_GUARDIAN"
                );
            }
            wallet.removeAllGuardians();
            wallet.addGuardiansImmediately(newGuardians);
        } else {
            if (wallet.isGuardian(newOwner, true)) {
                wallet.deleteGuardian(newOwner, block.timestamp, true);
            }
            wallet.cancelPendingGuardians();
        }

        emit Recovered(newOwner);
    }

    function verifyApproval(
        Wallet storage wallet,
        bytes32 domainSeparator,
        bytes memory callData,
        bytes memory signature
    ) external returns (uint256) {
        (address newOwner, address[] memory newGuardians) = abi.decode(
            callData,
            (address, address[])
        );
        Approval memory approval = abi.decode(signature, (Approval));

        return
            ApprovalLib.verifyApproval(
                wallet,
                domainSeparator,
                SigRequirement.MAJORITY_OWNER_NOT_ALLOWED,
                approval,
                abi.encode(
                    RECOVER_TYPEHASH,
                    approval.wallet,
                    approval.validUntil,
                    newOwner,
                    keccak256(abi.encodePacked(newGuardians))
                )
            );
    }
}