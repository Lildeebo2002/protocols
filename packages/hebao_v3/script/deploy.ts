import { ethers } from "hardhat";
import { Contract, Wallet, Signer, BigNumber, BigNumberish } from "ethers";
import BN from "bn.js";
import { signCreateWallet } from "../test/helper/signatureUtils";
import {
  localUserOpSender,
  fillAndSign,
  SendUserOp,
} from "../test/helper/AASigner";
import { parseEther, arrayify, hexConcat, hexlify } from "ethers/lib/utils";
import { Deferrable, resolveProperties } from "@ethersproject/properties";
import {
  BaseProvider,
  Provider,
  TransactionRequest,
  TransactionReceipt,
} from "@ethersproject/providers";
import {
  EntryPoint,
  SmartWalletV3,
  EntryPoint__factory,
  SmartWalletV3__factory,
  WalletFactory,
  WalletFactory__factory,
  WalletProxy__factory,
  VerifyingPaymaster,
  VerifyingPaymaster__factory,
  LoopringCreate2Deployer,
} from "../typechain-types";
import {
  activateCreate2WalletOp,
  simulationResultCatch,
  computeRequiredPreFund,
  createTransaction,
  createBatchTransactions,
  getPaymasterAndData,
} from "../test/helper/utils";

export async function deploySingle(
  deployFactory: Contract,
  contractName: string,
  args?: any[],
  libs?: Map<string, any>
) {
  // use same salt for all deployments:
  const salt = ethers.utils.formatBytes32String("0x5");

  const libraries = {}; // libs ? Object.fromEntries(libs) : {}; // requires lib: ["es2019"]
  libs && libs.forEach((value, key) => (libraries[key] = value));
  // console.log("libraries:", libraries);

  const contract = await ethers.getContractFactory(contractName, { libraries });

  let deployableCode = contract.bytecode;
  if (args && args.length > 0) {
    deployableCode = ethers.utils.hexConcat([
      deployableCode,
      contract.interface.encodeDeploy(args),
    ]);
  }

  const deployedAddress = ethers.utils.getCreate2Address(
    deployFactory.address,
    salt,
    ethers.utils.keccak256(deployableCode)
  );
  // check if it is deployed already
  if ((await ethers.provider.getCode(deployedAddress)) != "0x") {
    console.log(contractName, " is deployed already at: ", deployedAddress);
  } else {
    const gasLimit = await deployFactory.estimateGas.deploy(
      deployableCode,
      salt
    );
    const tx = await deployFactory.deploy(deployableCode, salt, { gasLimit });
    await tx.wait();
    console.log(contractName, "deployed address: ", deployedAddress);
  }

  return contract.attach(deployedAddress);
}

export async function deployWalletImpl(
  deployFactory: Contract,
  entryPointAddr: string,
  blankOwner: string
) {
  const ERC1271Lib = await deploySingle(deployFactory, "ERC1271Lib");
  const ERC20Lib = await deploySingle(deployFactory, "ERC20Lib");
  const GuardianLib = await deploySingle(deployFactory, "GuardianLib");
  const InheritanceLib = await deploySingle(deployFactory, "InheritanceLib");
  const QuotaLib = await deploySingle(deployFactory, "QuotaLib");
  const UpgradeLib = await deploySingle(deployFactory, "UpgradeLib");
  const WhitelistLib = await deploySingle(deployFactory, "WhitelistLib");
  const LockLib = await deploySingle(
    deployFactory,
    "LockLib",
    undefined,
    new Map([["GuardianLib", GuardianLib.address]])
  );
  const RecoverLib = await deploySingle(
    deployFactory,
    "RecoverLib",
    undefined,
    new Map([["GuardianLib", GuardianLib.address]])
  );

  const smartWallet = await deploySingle(
    deployFactory,
    "SmartWalletV3",
    [ethers.constants.AddressZero, blankOwner, entryPointAddr],
    new Map([
      ["ERC1271Lib", ERC1271Lib.address],
      ["ERC20Lib", ERC20Lib.address],
      ["GuardianLib", GuardianLib.address],
      ["InheritanceLib", InheritanceLib.address],
      ["LockLib", LockLib.address],
      ["QuotaLib", QuotaLib.address],
      ["RecoverLib", RecoverLib.address],
      ["UpgradeLib", UpgradeLib.address],
      ["WhitelistLib", WhitelistLib.address],
    ])
  );
  return smartWallet;
}

export async function createSmartWallet(
  owner: Wallet,
  walletFactory: Contract
) {
  const guardians = [];
  const feeRecipient = ethers.constants.AddressZero;
  const salt = ethers.utils.formatBytes32String("0x5");
  const walletAddrComputed = await walletFactory.computeWalletAddress(
    owner.address,
    salt
  );
  if ((await ethers.provider.getCode(walletAddrComputed)) != "0x") {
    console.log(
      "smart wallet: ",
      owner.address,
      " is deployed already at: ",
      walletAddrComputed
    );
  } else {
    // create smart wallet
    const signature = signCreateWallet(
      walletFactory.address,
      owner.address,
      guardians,
      new BN(0),
      ethers.constants.AddressZero,
      feeRecipient,
      ethers.constants.AddressZero,
      new BN(0),
      salt,
      owner.privateKey.slice(2)
    );
    // console.log("signature:", signature);

    const walletConfig: any = {
      owner: owner.address,
      guardians,
      quota: 0,
      inheritor: ethers.constants.AddressZero,
      feeRecipient,
      feeToken: ethers.constants.AddressZero,
      maxFeeAmount: 0,
      salt,
      signature: Buffer.from(signature.txSignature.slice(2), "hex"),
    };

    const tx = await walletFactory.createWallet(walletConfig, 0);
    await tx.wait();
    console.log("wallet created at: ", walletAddrComputed);
  }
  return walletAddrComputed;
}

async function deployAll() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const paymasterOwner = new ethers.Wallet(
    process.env.PAYMASTER_OWNER_PRIVATE_KEY ?? process.env.PRIVATE_KEY,
    ethers.provider
  );
  const blankOwner = process.env.BLANK_OWNER ?? deployer.address;

  // create2 factory

  let create2: LoopringCreate2Deployer;
  const create2Addr = "0x515aC6B1Cd51BcFe88334039cC32e3919D13b35d";
  if ((await ethers.provider.getCode(create2Addr)) != "0x") {
    create2 = await ethers.getContractAt(
      "LoopringCreate2Deployer",
      create2Addr
    );
  } else {
    create2 = await (
      await ethers.getContractFactory("LoopringCreate2Deployer")
    ).deploy();
    console.log("create2 factory is deployed at : ", create2.address);
  }

  // entrypoint and paymaster
  const entrypoint = await deploySingle(create2, "EntryPoint");
  // const entrypointAddr = "0x515aC6B1Cd51BcFe88334039cC32e3919D13b35d";
  // const entrypoint = await ethers.getContractAt("EntryPoint", entrypointAddr);

  const paymaster = await deploySingle(create2, "VerifyingPaymaster", [
    entrypoint.address,
    paymasterOwner.address,
  ]);

  const smartWalletImpl = await deployWalletImpl(
    create2,
    entrypoint.address,
    blankOwner
  );

  const implStorage = await deploySingle(
    create2,
    "DelayedImplementationManager",
    // deployer as implementation manager
    [smartWalletImpl.address]
  );

  const forwardProxy = await deploySingle(create2, "ForwardProxy", [
    implStorage.address,
  ]);

  const walletFactory = await deploySingle(create2, "WalletFactory", [
    forwardProxy.address,
  ]);
  // transfer wallet factory ownership to deployer
  await create2.setTarget(walletFactory.address);
  const transferWalletFactoryOwnership =
    await walletFactory.populateTransaction.transferOwnership(deployer.address);
  await create2.transact(transferWalletFactoryOwnership.data);
  await walletFactory.addOperator(deployer.address);

  // transfer DelayedImplementationManager ownership to deployer
  await create2.setTarget(implStorage.address);
  const transferImplStorageOwnership =
    await implStorage.populateTransaction.transferOwnership(deployer.address);
  await create2.transact(transferImplStorageOwnership.data);

  // create demo wallet
  const smartWalletOwner = new ethers.Wallet(
    process.env.TEST_ACCOUNT_PRIVATE_KEY ?? deployer.address,
    ethers.provider
  );
  const sendUserOp = localUserOpSender(entrypoint.address, deployer);

  const smartWalletAddr = await createSmartWallet(
    smartWalletOwner,
    walletFactory
  );
  const smartWallet = SmartWalletV3__factory.connect(
    smartWalletAddr,
    smartWalletOwner
  );

  // deploy mock usdt token for test.
  const usdtToken = await deploySingle(create2, "USDT");
  return {
    entrypoint,
    paymaster: VerifyingPaymaster__factory.connect(
      paymaster.address,
      paymasterOwner
    ),
    forwardProxy,
    smartWallet,
    create2,
    deployer,
    paymasterOwner,
    blankOwner,
    smartWalletOwner,
    usdtToken,
    sendUserOp,
  };
}

interface PaymasterOption {
  paymaster: VerifyingPaymaster;
  payToken: Contract;
  paymasterOwner: Signer;
  valueOfEth: BigNumberish;
  validUntil: BigNumberish;
}

async function sendTx(
  txs: Deferrable<TransactionRequest>[],
  smartWallet: SmartWalletV3,
  smartWalletOwner: Signer,
  contractFactory: Contract,
  entrypoint: Contract,
  sendUserOp: SendUserOp,
  paymasterOption?: PaymasterOption
) {
  const ethSent = txs.reduce(
    (acc, tx) => acc.add(BigNumber.from(tx.value ?? 0)),
    BigNumber.from(0)
  );
  const partialUserOp = await createBatchTransactions(
    txs,
    ethers.provider,
    smartWallet
  );
  // first call to fill userop
  let signedUserOp = await fillAndSign(
    partialUserOp,
    smartWalletOwner,
    contractFactory.address,
    entrypoint
  );

  // handle paymaster
  if (paymasterOption) {
    const paymaster = paymasterOption.paymaster;
    const payToken = paymasterOption.payToken;
    const valueOfEth = paymasterOption.valueOfEth;
    const validUntil = paymasterOption.validUntil;

    const hash = await paymaster.getHash(
      signedUserOp,
      payToken.address,
      valueOfEth
    );

    const paymasterAndData = await getPaymasterAndData(
      paymaster.address,
      paymasterOption.paymasterOwner,
      hash,
      payToken.address,
      valueOfEth,
      validUntil
    );
    signedUserOp.paymasterAndData = paymasterAndData;
    signedUserOp = await fillAndSign(
      signedUserOp,
      smartWalletOwner,
      contractFactory.address,
      entrypoint
    );
  }

  // prepare gas before send userop
  const requiredPrefund = computeRequiredPreFund(
    signedUserOp,
    paymasterOption != undefined
  ).add(ethSent);
  // only consider deposited balance in entrypoint contract when using paymaster
  const currentBalance = paymasterOption
    ? await entrypoint.balanceOf(paymasterOption.paymaster.address)
    : await getEthBalance(smartWallet);

  if (requiredPrefund.gt(currentBalance)) {
    const missingValue = requiredPrefund.sub(currentBalance);
    const payer = paymasterOption
      ? paymasterOption.paymaster.address
      : smartWallet.address;
    await (
      await entrypoint.depositTo(payer, {
        value: missingValue,
      })
    ).wait();
    console.log("prefund missing amount ", missingValue);
  }

  // get details if throw error
  await entrypoint.callStatic
    .simulateValidation(signedUserOp)
    .catch(simulationResultCatch);
  const recipt = await sendUserOp(signedUserOp);
  return recipt;
}

async function getEthBalance(smartWallet: SmartWalletV3) {
  const ethBalance = await ethers.provider.getBalance(smartWallet.address);
  const depositBalance = await smartWallet.getDeposit();
  const totalBalance = ethBalance.add(depositBalance);
  return totalBalance;
}

async function testExecuteTxWithEth() {
  const {
    entrypoint,
    smartWallet,
    smartWalletOwner,
    usdtToken,
    deployer,
    sendUserOp,
    create2,
  } = await deployAll();
  // prepare mock usdt token first
  await (
    await usdtToken.setBalance(
      smartWallet.address,
      ethers.utils.parseUnits("1000", 6)
    )
  ).wait();

  //////////////////////////////////////////
  // usdt token transfer test
  const tokenAmount = ethers.utils.parseUnits("100", 6);
  const transferToken = await usdtToken.populateTransaction.transfer(
    deployer.address,
    tokenAmount
  );

  const recipt = await sendTx(
    [transferToken],
    smartWallet,
    smartWalletOwner,
    create2,
    entrypoint,
    sendUserOp
  );
  console.log("gas cost of usdt token transfer: ", recipt.gasUsed);
  ////////////////////////////////////
  // eth transfer test
  const ethAmount = 1;
  await (
    await deployer.sendTransaction({
      to: smartWallet.address,
      value: ethAmount,
    })
  ).wait();
  const transferEth = {
    value: ethAmount,
    to: deployer.address,
  };
  const recipt1 = await sendTx(
    [transferEth],
    smartWallet,
    smartWalletOwner,
    create2,
    entrypoint,
    sendUserOp
  );
  console.log("gas cost of eth transfer: ", recipt1.gasUsed);
  ///////////////////////////////
  // batch tx
  // transfer usdt token by three times

  const recipt2 = await sendTx(
    [transferToken, transferToken, transferToken],
    smartWallet,
    smartWalletOwner,
    create2,
    entrypoint,
    sendUserOp
  );
  console.log(
    "gas cost of usdt token transfer by three times(batch tx): ",
    recipt2.gasUsed
  );
}

async function testExecuteTxWithUSDCPaymaster() {
  const {
    entrypoint,
    smartWallet,
    smartWalletOwner,
    usdtToken,
    deployer,
    sendUserOp,
    create2,
    paymaster,
    paymasterOwner,
  } = await deployAll();
  console.log("deployer: ", deployer.address);
  // prepare mock usdt token first
  await (
    await usdtToken.setBalance(
      smartWallet.address,
      ethers.utils.parseUnits("1000", 6)
    )
  ).wait();

  //////////////////////////////////////////
  // usdt token transfer test
  const tokenAmount = ethers.utils.parseUnits("100", 6);
  // approve paymaster before using usdt paymaster service
  const approveToken = await usdtToken.populateTransaction.approve(
    paymaster.address,
    ethers.constants.MaxUint256
  );
  const transferToken = await usdtToken.populateTransaction.transfer(
    deployer.address,
    tokenAmount
  );
  const paymasterOption: PaymasterOption = {
    paymaster,
    payToken: usdtToken,
    paymasterOwner,
    valueOfEth: ethers.utils.parseUnits("625", 12),
    validUntil: 0,
  };

  const recipt = await sendTx(
    [approveToken, transferToken],
    smartWallet,
    smartWalletOwner,
    create2,
    entrypoint,
    sendUserOp,
    paymasterOption
  );
  console.log("gas cost of usdt token transfer: ", recipt.gasUsed);
}

async function main() {
  // await deployAll();
  // uncomment below to get gascost info on chain
  // await testExecuteTxWithEth();
  await testExecuteTxWithUSDCPaymaster();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });