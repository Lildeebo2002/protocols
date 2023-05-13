import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumberish, Wallet, PopulatedTransaction } from "ethers";
import { signChangeDailyQuotaWA } from "./helper/signatureUtils";
import {
  loadFixture,
  setBalance,
} from "@nomicfoundation/hardhat-network-helpers";
import { fixture } from "./helper/fixture";
import {
  sendTx,
  PaymasterOption,
  evInfo,
  sortSignersAndSignatures,
  getCurrentQuota,
  createSmartWallet,
} from "./helper/utils";
import { fillAndSign, UserOperation, fillUserOp } from "./helper/AASigner";
import {
  SmartWalletV3,
  EntryPoint,
  LoopringCreate2Deployer,
  SmartWalletV3__factory,
} from "../typechain-types";
import BN from "bn.js";

describe("eip4337 test", () => {
  // execute tx from entrypoint instead of `execute` or `executebatch`
  async function getSignedUserOp(
    tx: PopulatedTransaction,
    nonce: BigNumberish,
    smartWallet: SmartWalletV3,
    smartWalletOwner: Wallet,
    create2: LoopringCreate2Deployer,
    entrypoint: EntryPoint
  ) {
    const partialUserOp: Partial<UserOperation> = {
      sender: smartWallet.address,
      nonce,
      callData: tx.data,
      callGasLimit: "126880",
    };
    const signedUserOp = await fillAndSign(
      partialUserOp,
      smartWalletOwner,
      create2.address,
      entrypoint
    );
    return signedUserOp;
  }

  it("invalid nonce", async () => {
    const {
      smartWallet,
      smartWalletOwner,
      create2,
      deployer,
      sendUserOp,
      entrypoint,
    } = await loadFixture(fixture);
    const changeDailyQuota =
      await smartWallet.populateTransaction.changeDailyQuota(100);
    // too small or too larger, neither of them is valid
    const invalidNonces = [0, ethers.constants.MaxUint256];
    for (let i = 0; i < invalidNonces.length; ++i) {
      const signedUserOp = await getSignedUserOp(
        changeDailyQuota,
        invalidNonces[i],
        smartWallet,
        smartWalletOwner,
        create2,
        entrypoint
      );
      await expect(sendUserOp(signedUserOp))
        .to.revertedWithCustomError(entrypoint, "FailedOp")
        .withArgs(0, ethers.constants.AddressZero, "invalid nonce");
    }
  });
  it("execute tx directly from entrypoint", async () => {
    const {
      smartWallet,
      smartWalletOwner,
      create2,
      deployer,
      sendUserOp,
      entrypoint,
    } = await loadFixture(fixture);
    const addGuardian = await smartWallet.populateTransaction.addGuardian(
      ethers.constants.AddressZero
    );
    const nonce = (await smartWallet.nonce()).add(1);
    const signedUserOp = await getSignedUserOp(
      addGuardian,
      nonce,
      smartWallet,
      smartWalletOwner,
      create2,
      entrypoint
    );
    await sendUserOp(signedUserOp);

    // replay it using the same nonce
    await expect(sendUserOp(signedUserOp))
      .to.revertedWithCustomError(entrypoint, "FailedOp")
      .withArgs(0, ethers.constants.AddressZero, "invalid nonce");
  });
  it("cannot execute changeDailyQuota tx when wallet is locked", async () => {
    const {
      smartWallet,
      smartWalletOwner,
      create2,
      deployer,
      sendUserOp,
      entrypoint,
    } = await loadFixture(fixture);
    await smartWallet.lock();
    const changeDailyQuota =
      await smartWallet.populateTransaction.changeDailyQuota(100);
    const nonce = await smartWallet.nonce();
    const signedUserOp = await getSignedUserOp(
      changeDailyQuota,
      nonce.add(1),
      smartWallet,
      smartWalletOwner,
      create2,
      entrypoint
    );
    await expect(sendUserOp(signedUserOp))
      .to.revertedWithCustomError(entrypoint, "FailedOp")
      .withArgs(0, ethers.constants.AddressZero, "wallet is locked");
  });
  it("transfer token from wallet owner", async () => {
    const {
      smartWallet,
      smartWalletOwner,
      create2,
      deployer,
      sendUserOp,
      smartWalletImpl,
      paymaster,
      guardians,
      usdtToken,
    } = await loadFixture(fixture);
    const initTokenAmount = ethers.utils.parseUnits("1000", 6);
    await usdtToken.setBalance(smartWallet.address, initTokenAmount);
    const receiver = deployer.address;
    const usdtTokenBalanceBefore = await usdtToken.balanceOf(receiver);
    const tokenAmount = ethers.utils.parseUnits("100", 6);
    await smartWallet.transferToken(
      usdtToken.address,
      receiver,
      tokenAmount,
      "0x",
      false
    );
    const usdtTokenBalanceAfter = await usdtToken.balanceOf(receiver);
    expect(usdtTokenBalanceAfter.sub(usdtTokenBalanceBefore)).to.eq(
      tokenAmount
    );
  });
  it("transfer token with eth using entrypoint", async () => {
    const {
      entrypoint,
      smartWallet,
      smartWalletOwner,
      create2,
      deployer,
      sendUserOp,
      smartWalletImpl,
      paymaster,
      guardians,
      usdtToken,
    } = await loadFixture(fixture);
    const initTokenAmount = ethers.utils.parseUnits("1000", 6);
    await usdtToken.setBalance(smartWallet.address, initTokenAmount);
    const tokenAmount = ethers.utils.parseUnits("100", 6);
    const transferToken = await usdtToken.populateTransaction.transfer(
      deployer.address,
      tokenAmount
    );

    {
      const preDeposit = await smartWallet.getDeposit();
      const ethBalanceBefore = await ethers.provider.getBalance(
        deployer.address
      );
      const usdtTokenBalanceBefore = await usdtToken.balanceOf(
        deployer.address
      );
      // pay for gas using prefund eth
      const recipt = await sendTx(
        [transferToken],
        smartWallet,
        smartWalletOwner,
        create2,
        entrypoint,
        sendUserOp
      );
      const postDeposit = await smartWallet.getDeposit();
      const ethBalanceAfter = await ethers.provider.getBalance(
        deployer.address
      );
      const usdtTokenBalanceAfter = await usdtToken.balanceOf(deployer.address);
      const gasCost = recipt.effectiveGasPrice.mul(recipt.gasUsed);
      // relayer balance after = relayer balance before + ethReceived - gasCost
      expect(preDeposit.sub(postDeposit)).eq(
        ethBalanceAfter.sub(ethBalanceBefore).add(gasCost)
      );

      // check usdt token balance of receiver
      expect(usdtTokenBalanceAfter.sub(usdtTokenBalanceBefore)).to.eq(
        tokenAmount
      );
    }

    {
      // execute batch
      const usdtTokenBalanceBefore = await usdtToken.balanceOf(
        deployer.address
      );
      await expect(
        sendTx(
          [transferToken, transferToken],
          smartWallet,
          smartWalletOwner,
          create2,
          entrypoint,
          sendUserOp
        )
      ).not.to.reverted;
      const usdtTokenBalanceAfter = await usdtToken.balanceOf(deployer.address);
      // transfer tokens for two times
      expect(usdtTokenBalanceAfter.sub(usdtTokenBalanceBefore)).to.eq(
        tokenAmount.mul(2)
      );
    }

    // pay for gas using eth in smartwallet, transfer eth during userop execution
    // use up all prefund eth
    {
      await smartWallet.withdrawDepositTo(
        ethers.constants.AddressZero,
        await smartWallet.getDeposit()
      );
      const walletEthBalanceBefore = await ethers.provider.getBalance(
        smartWallet.address
      );
      const relayerEthBalanceBefore = await ethers.provider.getBalance(
        deployer.address
      );
      const recipt = await sendTx(
        [transferToken],
        smartWallet,
        smartWalletOwner,
        create2,
        entrypoint,
        sendUserOp
      );
      const walletEthBalanceAfter = await ethers.provider.getBalance(
        smartWallet.address
      );
      const relayerEthBalanceAfter = await ethers.provider.getBalance(
        deployer.address
      );
      // relayer balance after = relayer balance before + ethReceived - gasCost
      const gasCost = recipt.effectiveGasPrice.mul(recipt.gasUsed);
      // left gas will remain in entrypoint for the next usage
      const prefund = await smartWallet.getDeposit();
      expect(walletEthBalanceBefore.sub(walletEthBalanceAfter).sub(prefund)).eq(
        relayerEthBalanceAfter.sub(relayerEthBalanceBefore).add(gasCost)
      );
    }
  });

  it("deposit and withdraw eth in entrypoint", async () => {
    const {
      entrypoint,
      smartWallet,
      smartWalletOwner,
      create2,
      deployer,
      sendUserOp,
      smartWalletImpl,
      paymaster,
      guardians,
      usdtToken,
    } = await loadFixture(fixture);
    const preDeposit = await smartWallet.getDeposit();
    const amount = ethers.utils.parseEther("1");
    await smartWallet.addDeposit({ value: amount });
    const postDeposit = await smartWallet.getDeposit();
    expect(postDeposit.sub(preDeposit)).to.eq(amount);
    // withdraw deposited eth
    const receiver = deployer.address;
    const preBalance = await ethers.provider.getBalance(receiver);
    await smartWallet.withdrawDepositTo(receiver, postDeposit);
    const postBalance = await ethers.provider.getBalance(receiver);
    expect(await smartWallet.getDeposit()).to.eq(0);
    expect(postBalance.sub(preBalance)).to.eq(postDeposit);
  });

  it("skip nonce success when changing dailyquota with approval even if wallet is locked", async () => {
    const {
      entrypoint,
      smartWallet,
      smartWalletOwner,
      create2,
      deployer,
      sendUserOp,
      smartWalletImpl,
      paymaster,
      guardians,
      usdtToken,
    } = await loadFixture(fixture);
    // lock wallet first
    await smartWallet.lock();

    const newQuota = 100;
    const changeDailyQuotaWA =
      await smartWallet.populateTransaction.changeDailyQuotaWA(newQuota);
    const partialUserOp = {
      sender: smartWallet.address,
      nonce: 0,
      callData: changeDailyQuotaWA.data,
      callGasLimit: "126880",
    };
    const userOp = await fillUserOp(partialUserOp, create2.address, entrypoint);
    const masterCopy = smartWalletImpl.address;
    const validUntil = 9999999999;
    const sig1 = signChangeDailyQuotaWA(
      masterCopy,
      smartWallet.address,
      new BN(validUntil),
      new BN(newQuota),
      smartWalletOwner.address,
      smartWalletOwner.privateKey.slice(2)
    );
    const sig1Bs = Buffer.from(sig1.txSignature.slice(2), "hex");

    const sig2 = signChangeDailyQuotaWA(
      masterCopy,
      smartWallet.address,
      new BN(validUntil),
      new BN(newQuota),
      guardians[0].address,
      guardians[0].privateKey.slice(2)
    );
    const sig2Bs = Buffer.from(sig2.txSignature.slice(2), "hex");

    const sortedSigs = sortSignersAndSignatures(
      [smartWalletOwner.address, guardians[0].address],
      [sig1Bs, sig2Bs]
    );

    const approval = {
      signers: sortedSigs.sortedSigners,
      signatures: sortedSigs.sortedSignatures,
      validUntil,
      wallet: smartWallet.address,
    };
    const signature = ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(address[] signers,bytes[] signatures,uint256 validUntil,address wallet)",
      ],
      [approval]
    );
    const signedUserOp = {
      ...userOp,
      signature,
    };
    const recipt = await sendUserOp(signedUserOp);
    const quotaInfo = (await smartWallet.wallet())["quota"];
    const currentQuota = await getCurrentQuota(quotaInfo, recipt.blockNumber);
    expect(currentQuota).to.equal(newQuota);
    expect(quotaInfo.pendingUntil.toString()).to.equal("0");

    // replay it when using the same aproval hash
    await expect(sendUserOp(signedUserOp))
      .to.revertedWithCustomError(entrypoint, "FailedOp")
      .withArgs(0, ethers.constants.AddressZero, "HASH_EXIST");
  });

  describe("read methods", () => {
    it("quota", async () => {
      const { smartWallet } = await loadFixture(fixture);
      const walletData = await smartWallet.wallet();
      const quotaInfo = walletData["quota"];
      // TODO(add check for quota info)
    });

    it("guardians", async () => {
      const { smartWallet, guardians } = await loadFixture(fixture);
      const actualGuardians = await smartWallet.getGuardians(true);
      // TODO(add check here)
    });

    it("isWhitelisted", async () => {
      const { smartWallet } = await loadFixture(fixture);
      const isWhitelisted = await smartWallet.isWhitelisted(
        "0x" + "22".repeat(20)
      );
      // TODO(add check here)
    });

    it("getNonce", async () => {
      const { smartWallet } = await loadFixture(fixture);
      const walletData = await smartWallet.wallet();
      expect(walletData["nonce"]).to.eq(0);
    });
  });

  describe("owner setter", () => {
    it("should be able to set owner for a blank wallet", async () => {
      const { entrypoint, walletFactory, blankOwner, deployer, guardians } =
        await loadFixture(fixture);
      const ownerSetter = blankOwner.address;
      const other = ethers.Wallet.createRandom().connect(ethers.provider);
      // prepare gas fee
      await setBalance(other.address, ethers.utils.parseEther("1"));

      const salt = ethers.utils.formatBytes32String("0x5");
      await createSmartWallet(
        blankOwner,
        guardians.map((g) => g.address.toLowerCase()).sort(),
        walletFactory,
        salt
      );

      const smartWalletAddr = await walletFactory.computeWalletAddress(
        blankOwner.address,
        salt
      );
      const smartWallet = SmartWalletV3__factory.connect(
        smartWalletAddr,
        blankOwner
      );

      // check owner before:
      const ownerBefore = (await smartWallet.wallet()).owner;
      expect(ownerBefore.toLowerCase()).to.equal(ownerSetter.toLowerCase());

      const newOwner = "0x" + "12".repeat(20);
      // other accounts can not set owner:
      await expect(
        smartWallet.connect(other).transferOwnership(newOwner)
      ).to.rejectedWith("NOT_ALLOWED_TO_SET_OWNER");

      // ownerSetter should be able to set owner if owner is blankOwner
      await smartWallet.connect(blankOwner).transferOwnership(newOwner);
      const ownerAfter = (await smartWallet.wallet()).owner;
      expect(ownerAfter.toLowerCase()).to.equal(newOwner.toLowerCase());

      // ownerSetter should not be able to set owner again
      const newOwner2 = "0x" + "34".repeat(20);
      await expect(
        smartWallet.connect(blankOwner).transferOwnership(newOwner2)
      ).to.rejectedWith("NOT_ALLOWED_TO_SET_OWNER");
    });
  });
});