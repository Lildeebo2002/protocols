// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2017 Loopring Technology Limited.
pragma solidity ^0.8.17;
pragma experimental ABIEncoderV2;

import "../../thirdparty/SafeERC20.sol";
import "../../lib/ERC20.sol";
import "../../lib/MathUint.sol";
import "../../lib/AddressUtil.sol";
import "../../iface/PriceOracle.sol";
import "../../thirdparty/BytesUtil.sol";
import "./WhitelistLib.sol";
import "./QuotaLib.sol";

/// @title ERC20Lib
/// @author Brecht Devos - <brecht@loopring.org>
/// @author Daniel Wang - <daniel@loopring.org>
library ERC20Lib {
    using AddressUtil for address;
    using BytesUtil for bytes;
    using MathUint for uint;
    using WhitelistLib for Wallet;
    using QuotaLib for Wallet;
    using SafeERC20 for ERC20;

    event Transfered(address token, address to, uint amount, bytes logdata);
    event Approved(address token, address spender, uint amount);
    event ContractCalled(address to, uint value, bytes data);

    bytes32 public constant TRANSFER_TOKEN_TYPEHASH =
        keccak256(
            "transferToken(address wallet,uint256 validUntil,address token,address to,uint256 amount,bytes logdata)"
        );
    bytes32 public constant APPROVE_TOKEN_TYPEHASH =
        keccak256(
            "approveToken(address wallet,uint256 validUntil,address token,address to,uint256 amount)"
        );
    bytes32 public constant CALL_CONTRACT_TYPEHASH =
        keccak256(
            "callContract(address wallet,uint256 validUntil,address to,uint256 value,bytes data)"
        );
    bytes32 public constant APPROVE_THEN_CALL_CONTRACT_TYPEHASH =
        keccak256(
            "approveThenCallContract(address wallet,uint256 validUntil,address token,address to,uint256 amount,uint256 value,bytes data)"
        );

    function transferToken(
        Wallet storage wallet,
        PriceOracle priceOracle,
        address token,
        address to,
        uint amount,
        bytes calldata logdata,
        bool forceUseQuota
    ) external {
        if (forceUseQuota || !wallet.isAddressWhitelisted(to)) {
            wallet.checkAndAddToSpent(priceOracle, token, amount);
        }
        _transferWithEvent(token, to, amount, logdata);
    }

    function transferTokenWA(
        address token,
        address to,
        uint amount,
        bytes calldata logdata
    ) external {
        _transferWithEvent(token, to, amount, logdata);
    }

    function callContract(
        Wallet storage wallet,
        PriceOracle priceOracle,
        address to,
        uint value,
        bytes calldata data,
        bool forceUseQuota
    ) external returns (bytes memory returnData) {
        if (forceUseQuota || !wallet.isAddressWhitelisted(to)) {
            wallet.checkAndAddToSpent(priceOracle, address(0), value);
        }

        return _callContractInternal(to, value, data, priceOracle);
    }

    function callContractWA(
        address to,
        uint value,
        bytes calldata data
    ) external returns (bytes memory returnData) {
        returnData = _callContractInternal(
            to,
            value,
            data,
            PriceOracle(address(0))
        );
    }

    function approveToken(
        Wallet storage wallet,
        PriceOracle priceOracle,
        address token,
        address to,
        uint amount,
        bool forceUseQuota
    ) external {
        uint additionalAllowance = _approveInternal(token, to, amount);

        if (forceUseQuota || !wallet.isAddressWhitelisted(to)) {
            wallet.checkAndAddToSpent(priceOracle, token, additionalAllowance);
        }
    }

    function approveTokenWA(address token, address to, uint amount) external {
        _approveInternal(token, to, amount);
    }

    function approveThenCallContract(
        Wallet storage wallet,
        PriceOracle priceOracle,
        address token,
        address to,
        uint amount,
        uint value,
        bytes calldata data,
        bool forceUseQuota
    ) external returns (bytes memory returnData) {
        uint additionalAllowance = _approveInternal(token, to, amount);

        if (forceUseQuota || !wallet.isAddressWhitelisted(to)) {
            wallet.checkAndAddToSpent(priceOracle, token, additionalAllowance);
            wallet.checkAndAddToSpent(priceOracle, address(0), value);
        }

        return _callContractInternal(to, value, data, priceOracle);
    }

    function approveThenCallContractWA(
        address token,
        address to,
        uint amount,
        uint value,
        bytes calldata data
    ) external returns (bytes memory returnData) {
        _approveInternal(token, to, amount);
        returnData = _callContractInternal(
            to,
            value,
            data,
            PriceOracle(address(0))
        );
    }

    function transfer(address token, address to, uint amount) public {
        if (token == address(0)) {
            to.sendETHAndVerify(amount, gasleft());
        } else {
            ERC20(token).safeTransfer(to, amount);
        }
    }

    // --- Internal functions ---

    function _transferWithEvent(
        address token,
        address to,
        uint amount,
        bytes calldata logdata
    ) private {
        transfer(token, to, amount);
        emit Transfered(token, to, amount, logdata);
    }

    function _approveInternal(
        address token,
        address spender,
        uint amount
    ) private returns (uint additionalAllowance) {
        // Current allowance
        uint allowance = ERC20(token).allowance(address(this), spender);

        if (amount != allowance) {
            // First reset the approved amount if needed
            if (allowance > 0) {
                ERC20(token).safeApprove(spender, 0);
            }
            // Now approve the requested amount
            ERC20(token).safeApprove(spender, amount);
        }

        // If we increased the allowance, calculate by how much
        if (amount > allowance) {
            additionalAllowance = amount.sub(allowance);
        }
        emit Approved(token, spender, amount);
    }

    function _callContractInternal(
        address to,
        uint value,
        bytes calldata txData,
        PriceOracle priceOracle
    ) private returns (bytes memory returnData) {
        require(to != address(this), "SELF_CALL_DISALLOWED");

        if (priceOracle != PriceOracle(address(0))) {
            if (txData.length >= 4) {
                bytes4 methodId = txData.toBytes4(0);
                // bytes4(keccak256("transfer(address,uint256)")) = 0xa9059cbb
                // bytes4(keccak256("approve(address,uint256)")) = 0x095ea7b3
                if (
                    methodId == bytes4(0xa9059cbb) ||
                    methodId == bytes4(0x095ea7b3)
                ) {
                    // Disallow general calls to token contracts (for tokens that have price data
                    // so the quota is actually used).
                    require(
                        priceOracle.tokenValue(to, 1e18) == 0,
                        "CALL_DISALLOWED"
                    );
                }
            }
        }

        bool success;
        (success, returnData) = to.call{value: value}(txData);
        require(success, "CALL_FAILED");

        emit ContractCalled(to, value, txData);
    }

    function verifyApprovalForApproveThenCallContract(
        Wallet storage wallet,
        bytes32 domainSeparator,
        bytes memory callData
    ) external returns (uint256) {
        (
            Approval memory approval,
            address token,
            address to,
            uint amount,
            uint value,
            bytes memory data
        ) = abi.decode(
                callData,
                (Approval, address, address, uint, uint, bytes)
            );
        return
            ApprovalLib.verifyApproval(
                wallet,
                domainSeparator,
                SigRequirement.MAJORITY_OWNER_REQUIRED,
                approval,
                abi.encode(
                    ERC20Lib.APPROVE_THEN_CALL_CONTRACT_TYPEHASH,
                    approval.wallet,
                    approval.validUntil,
                    token,
                    to,
                    amount,
                    value,
                    keccak256(data)
                )
            );
    }

    function verifyApprovalForApproveToken(
        Wallet storage wallet,
        bytes32 domainSeparator,
        bytes memory callData
    ) external returns (uint256) {
        (Approval memory approval, address token, address to, uint amount) = abi
            .decode(callData, (Approval, address, address, uint));
        return
            ApprovalLib.verifyApproval(
                wallet,
                domainSeparator,
                SigRequirement.MAJORITY_OWNER_REQUIRED,
                approval,
                abi.encode(
                    ERC20Lib.APPROVE_TOKEN_TYPEHASH,
                    approval.wallet,
                    approval.validUntil,
                    token,
                    to,
                    amount
                )
            );
    }

    function verifyApprovalForCallContract(
        Wallet storage wallet,
        bytes32 domainSeparator,
        bytes memory callData
    ) external returns (uint256) {
        (
            Approval memory approval,
            address to,
            uint value,
            bytes memory data
        ) = abi.decode(callData, (Approval, address, uint, bytes));
        return
            ApprovalLib.verifyApproval(
                wallet,
                domainSeparator,
                SigRequirement.MAJORITY_OWNER_REQUIRED,
                approval,
                abi.encode(
                    ERC20Lib.CALL_CONTRACT_TYPEHASH,
                    approval.wallet,
                    approval.validUntil,
                    to,
                    value,
                    keccak256(data)
                )
            );
    }

    function verifyApprovalForTransferToken(
        Wallet storage wallet,
        bytes32 domainSeparator,
        bytes memory callData
    ) external returns (uint256) {
        (
            Approval memory approval,
            address token,
            address to,
            uint amount,
            bytes memory logdata
        ) = abi.decode(callData, (Approval, address, address, uint, bytes));
        return
            ApprovalLib.verifyApproval(
                wallet,
                domainSeparator,
                SigRequirement.MAJORITY_OWNER_REQUIRED,
                approval,
                abi.encode(
                    ERC20Lib.TRANSFER_TOKEN_TYPEHASH,
                    approval.wallet,
                    approval.validUntil,
                    token,
                    to,
                    amount,
                    keccak256(logdata)
                )
            );
    }
}
