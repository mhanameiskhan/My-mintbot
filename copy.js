async function copyMint(contractAddress, sourceTxHash, sourceWallet) {
  console.log(`\n[mint detected] wallet=${sourceWallet} contract=${contractAddress} tx=${sourceTxHash}`);

  await notify(
    `🔔 <b>Mint Detected</b>\n` +
    `Wallet: <code>${escapeHtml(sourceWallet)}</code>\n` +
    `Contract: <code>${escapeHtml(contractAddress)}</code>\n` +
    `Tx: <code>${escapeHtml(sourceTxHash)}</code>`
  );

  // ========== Detect quantity ==========
  let detectedQty = 1;

  try {
    const provider = rpcPool.current();
    const receipt = await provider.getTransactionReceipt(sourceTxHash);

    if (receipt && receipt.logs) {
      let count = 0;
      for (const log of receipt.logs) {
        if (
          log.topics.length >= 3 &&
          log.topics[0] === ERC721_TRANSFER_TOPIC &&
          log.topics[1] === ethers.zeroPadValue(NULL_ADDRESS, 32)
        ) {
          const toAddress = ethers.getAddress('0x' + log.topics[2].slice(26)).toLowerCase();
          if (toAddress === sourceWallet.toLowerCase()) {
            count++;
          }
        }
      }
      if (count > 0) detectedQty = count;
    }

    await notify(`📊 Detected quantity from watched wallet: <b>${detectedQty}</b>`);
  } catch (err) {
    console.warn(`[mint] Quantity detection failed: ${err.message}`);
    await notify(`⚠️ Could not detect quantity, defaulting to 1`);
  }

  const quantitiesToTry = detectedQty > 1 ? [detectedQty, 1] : [1];
  await notify(`🧪 Will try quantities: <b>${quantitiesToTry.join(', ')}</b>`);

  // ========== Get OpenSea collection ==========
  let slug;
  try {
    slug = await resolveCollectionSlug(contractAddress);
  } catch (err) {
    await notify(`⚠️ OpenSea lookup failed: ${escapeHtml(err.message)}\nTrying direct mint...`);
    return attemptDirectMint(contractAddress, sourceWallet);
  }

  if (!slug) {
    await notify(`⚠️ No OpenSea Drop found for this contract.\nTrying direct mint...`);
    return attemptDirectMint(contractAddress, sourceWallet);
  }

  await notify(`📦 Collection found: <code>${escapeHtml(slug)}</code>`);

  // ========== Try each quantity ==========
  for (const qty of quantitiesToTry) {
    await notify(`⏳ Trying to mint <b>${qty}</b> of <code>${escapeHtml(slug)}</code>...`);

    let raw;
    try {
      raw = await buildDropMintTransaction(
        slug,
        DRY_RUN ? (WALLET_ADDRESS || ethers.ZeroAddress) : WALLET_ADDRESS,
        qty
      );
    } catch (err) {
      await notify(`❌ Failed to build transaction for qty ${qty}:\n<code>${escapeHtml(err.message)}</code>`);
      continue;
    }

    const { to, data, value } = readMintTxFields(raw);
    if (!to || !data) {
      await notify(`❌ Invalid transaction data for qty ${qty}`);
      continue;
    }

    const valueWei = BigInt(value || '0');
    const valueEth = Number(ethers.formatEther(valueWei));

    await notify(`💰 Price for qty ${qty}: <b>${valueEth} ETH</b>`);

    if (MAX_PRICE_ETH !== null && valueEth > MAX_PRICE_ETH) {
      await notify(`⏭ Skipped qty ${qty} — above your MAX_PRICE_ETH limit`);
      continue;
    }

    // Dry Run Mode
    if (DRY_RUN) {
      await notify(
        `🧪 <b>DRY RUN</b>\nWould mint <b>${qty}</b> of <code>${escapeHtml(slug)}</code> for ${valueEth} ETH`
      );
      return;
    }

    // Real Mint
    try {
      const provider = rpcPool.current();
      const connectedSigner = signer.connect(provider);

      const balance = await provider.getBalance(WALLET_ADDRESS);
      await notify(`💼 Wallet balance: ${ethers.formatEther(balance)} ETH`);

      const gasEstimate = await provider.estimateGas({
        to,
        data,
        value: valueWei,
        from: WALLET_ADDRESS,
      });

      const feeData = await provider.getFeeData();
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      const totalCost = valueWei + (gasEstimate * gasPrice);

      if (balance < totalCost) {
        await notify(`❌ Not enough balance for qty ${qty}`);
        continue;
      }

      const tx = await connectedSigner.sendTransaction({
        to,
        data,
        value: valueWei,
      });

      await notify(`🚀 Transaction sent!\nTx: <code>${escapeHtml(tx.hash)}</code>\nWaiting for confirmation...`);

      const receipt = await tx.wait();

      if (receipt.status === 1) {
        await notify(
          `✅ <b>SUCCESS!</b>\nMinted <b>${qty}</b> of <code>${escapeHtml(slug)}</code>\nTx: <code>${escapeHtml(tx.hash)}</code>`
        );
        return;
      } else {
        await notify(`⚠️ Transaction reverted for qty ${qty}`);
      }
    } catch (err) {
      await notify(`❌ Mint failed for qty ${qty}:\n<code>${escapeHtml(err.message)}</code>`);
      continue;
    }
  }

  await notify(`❌ All attempts failed for <code>${escapeHtml(slug)}</code>`);
}