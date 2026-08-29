async function copyMint(contractAddress, sourceTxHash, sourceWallet) {
  console.log(`\n[mint detected] wallet=${sourceWallet} contract=${contractAddress} source_tx=${sourceTxHash}`);

  await notify(
    `🔔 <b>Mint detected</b>\nWallet: <code>${escapeHtml(sourceWallet)}</code>\nContract: <code>${escapeHtml(contractAddress)}</code>\nTx: <code>${escapeHtml(sourceTxHash)}</code>`
  );

  // ===== Detect how many the watched wallet minted =====
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
      if (count > 0) {
        detectedQty = count;
      }
    }
  } catch (err) {
    console.warn(`[mint] Could not detect quantity, using 1 → ${err.message}`);
  }

  console.log(`[mint] Detected quantity: ${detectedQty}`);

  // Quantities to try: detected quantity first, then 1
  const quantitiesToTry = detectedQty > 1 ? [detectedQty, 1] : [1];

  // ===== Resolve OpenSea collection =====
  let slug;
  try {
    slug = await resolveCollectionSlug(contractAddress);
  } catch (err) {
    console.warn(`[opensea] lookup failed: ${err.message}`);
    return attemptDirectMint(contractAddress, sourceWallet);
  }

  if (!slug) {
    console.warn(`[opensea] No drop found`);
    return attemptDirectMint(contractAddress, sourceWallet);
  }

  // ===== Try quantities =====
  for (const qty of quantitiesToTry) {
    console.log(`[mint] Trying quantity ${qty}...`);

    let raw;
    try {
      raw = await buildDropMintTransaction(
        slug,
        DRY_RUN ? (WALLET_ADDRESS || ethers.ZeroAddress) : WALLET_ADDRESS,
        qty
      );
    } catch (err) {
      console.warn(`[opensea] Failed to build tx for qty ${qty}: ${err.message}`);
      continue;
    }

    const { to, data, value } = readMintTxFields(raw);
    if (!to || !data) {
      console.warn(`[opensea] Invalid tx data for qty ${qty}`);
      continue;
    }

    const valueWei = BigInt(value || '0');
    const valueEth = Number(ethers.formatEther(valueWei));

    if (MAX_PRICE_ETH !== null && valueEth > MAX_PRICE_ETH) {
      console.warn(`[skip] Price too high: ${valueEth} ETH`);
      await notify(`⏭ Skipped <code>${escapeHtml(slug)}</code> — ${valueEth} ETH is above your limit`);
      return;
    }

    // Dry Run
    if (DRY_RUN) {
      await notify(
        `🧪 <b>Dry run</b>: would mint <b>${qty}</b> of <code>${escapeHtml(slug)}</code> for ${valueEth} ETH`
      );
      return;
    }

    // Real mint
    try {
      const provider = rpcPool.current();
      const connectedSigner = signer.connect(provider);

      const balance = await provider.getBalance(WALLET_ADDRESS);
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
        console.warn(`[mint] Insufficient balance for qty ${qty}`);
        continue;
      }

      const tx = await connectedSigner.sendTransaction({
        to,
        data,
        value: valueWei,
      });

      console.log(`[mint] Transaction sent: ${tx.hash}`);
      const receipt = await tx.wait();

      if (receipt.status === 1) {
        await notify(
          `✅ <b>Successfully minted ${qty}</b> of <code>${escapeHtml(slug)}</code>\nTx: <code>${escapeHtml(tx.hash)}</code>`
        );
        return; // Stop after success
      } else {
        console.warn(`[mint] Transaction reverted for qty ${qty}`);
      }
    } catch (err) {
      console.warn(`[mint] Failed qty ${qty}: ${err.message}`);
      continue;
    }
  }

  // If we reach here, all attempts failed
  await notify(`❌ Failed to mint <code>${escapeHtml(slug)}</code> (tried: ${quantitiesToTry.join(', ')})`);
}