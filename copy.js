async function copyMint(contractAddress, sourceTxHash, sourceWallet) {
  console.log(`\n[mint detected] wallet=${sourceWallet} contract=${contractAddress} source_tx=${sourceTxHash}`);

  await notify(
    `🔔 <b>Mint detected</b>\nWallet: <code>${escapeHtml(sourceWallet)}</code>\nContract: <code>${escapeHtml(contractAddress)}</code>\nTx: <code>${escapeHtml(sourceTxHash)}</code>`
  );

  // Detect how many NFTs the watched wallet received
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
          const toAddress = ('0x' + log.topics[2].slice(26)).toLowerCase();
          if (toAddress === sourceWallet.toLowerCase()) {
            count++;
          }
        }
      }
      if (count > 0) detectedQty = count;
    }
  } catch (err) {
    console.warn(`[mint] Could not detect quantity: ${err.message}`);
  }

  // Quantities to try (highest first)
  let quantityTries = (process.env.QUANTITY_TRIES || '10,5,3,2,1')
    .split(',')
    .map(n => Number(n.trim()))
    .filter(n => n > 0);

  // Make sure detected quantity is also tried
  if (!quantityTries.includes(detectedQty)) {
    quantityTries.push(detectedQty);
  }

  // Remove duplicates and sort highest → lowest
  quantityTries = [...new Set(quantityTries)].sort((a, b) => b - a);

  await notify(`📊 Detected quantity: <b>${detectedQty}</b>\nWill try: <b>${quantityTries.join(', ')}</b>`);

  // Find OpenSea collection
  let slug;
  try {
    slug = await resolveCollectionSlug(contractAddress);
  } catch (err) {
    console.warn(`[opensea] lookup failed: ${err.message}`);
    return attemptDirectMint(contractAddress, sourceWallet);
  }

  if (!slug) {
    console.warn(`[opensea] No OpenSea Drop found`);
    return attemptDirectMint(contractAddress, sourceWallet);
  }

  await notify(`📦 Collection: <code>${escapeHtml(slug)}</code>`);

  // Try each quantity from highest to lowest
  for (const qty of quantityTries) {
    await notify(`⏳ Trying quantity <b>${qty}</b>...`);

    let raw;
    try {
      raw = await buildDropMintTransaction(
        slug,
        DRY_RUN ? (WALLET_ADDRESS || ethers.ZeroAddress) : WALLET_ADDRESS,
        qty
      );
    } catch (err) {
      await notify(`❌ Could not build transaction for qty ${qty}`);
      continue;
    }

    const { to, data, value } = readMintTxFields(raw);
    if (!to || !data) {
      await notify(`❌ Invalid data for qty ${qty}`);
      continue;
    }

    const valueWei = BigInt(value || '0');
    const valueEth = Number(ethers.formatEther(valueWei));

    await notify(`💰 Price for ${qty}: <b>${valueEth} ETH</b>`);

    if (MAX_PRICE_ETH !== null && valueEth > MAX_PRICE_ETH) {
      await notify(`⏭ Qty ${qty} is above your MAX_PRICE_ETH limit`);
      continue;
    }

    if (DRY_RUN) {
      await notify(`🧪 <b>Dry run</b>: would mint <b>${qty}</b> for ${valueEth} ETH`);
      return;
    }

    // Real mint attempt
    try {
      const provider = rpcPool.current();
      const connectedSigner = signer.connect(provider);

      const balance = await provider.getBalance(WALLET_ADDRESS);
      const gasEstimate = await provider.estimateGas({
        to,
        data,
        value: valueWei,
        from: WALLET_ADDRESS
      });
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      const totalCost = valueWei + gasEstimate * gasPrice;

      if (balance < totalCost) {
        await notify(`❌ Not enough balance for qty ${qty}`);
        continue;
      }

      const tx = await connectedSigner.sendTransaction({
        to,
        data,
        value: valueWei
      });

      await notify(`🚀 Transaction sent for qty ${qty}\n<code>${escapeHtml(tx.hash)}</code>`);

      const receipt = await tx.wait();

      if (receipt.status === 1) {
        await notify(
          `✅ <b>SUCCESS</b>\nMinted <b>${qty}</b> of <code>${escapeHtml(slug)}</code>\nTx: <code>${escapeHtml(tx.hash)}</code>`
        );
        return; // Stop after first success
      } else {
        await notify(`⚠️ Transaction reverted for qty ${qty}`);
      }
    } catch (err) {
      await notify(`❌ Qty ${qty} failed: ${escapeHtml(err.message)}`);
      continue;
    }
  }

  await notify(`❌ All quantity attempts failed`);
}