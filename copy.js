async function copyMint(contractAddress, sourceTxHash, sourceWallet) {
  console.log("===== COPY MINT FUNCTION CALLED =====");
  console.log("Contract:", contractAddress);
  console.log("Source Wallet:", sourceWallet);
  console.log("Tx Hash:", sourceTxHash);

  await notify(`🔔 Test: copyMint function was called for ${sourceWallet}`);

  // ========== 1. Detect how many the watched wallet minted ==========
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
  } catch (err) {
    console.warn(`[mint] Could not detect quantity, defaulting to 1 → ${err.message}`);
  }

  console.log(`[mint] Detected quantity from source wallet: ${detectedQty}`);

  // ========== 2. Build list of quantities to try (highest first) ==========
  // You can change this list in .env with QUANTITY_TRIES=10,5,3,2,1
  const defaultTries = [10, 5, 3, 2, 1];
  let quantityTries = (process.env.QUANTITY_TRIES || defaultTries.join(','))
    .split(',')
    .map(n => Number(n.trim()))
    .filter(n => n > 0);

  // Make sure the detected quantity is also tried
  if (!quantityTries.includes(detectedQty)) {
    quantityTries.push(detectedQty);
  }

  // Sort highest to lowest and remove duplicates
  quantityTries = [...new Set(quantityTries)].sort((a, b) => b - a);

  console.log(`[mint] Will try quantities: ${quantityTries.join(', ')}`);

  // ========== 3. Resolve OpenSea collection ==========
  let slug;
  try {
    slug = await resolveCollectionSlug(contractAddress);
  } catch (err) {
    console.warn(`[opensea] contract lookup failed: ${err.message}. Falling back to direct mint.`);
    return attemptDirectMint(contractAddress, sourceWallet);
  }

  if (!slug) {
    console.warn(`[opensea] No OpenSea collection found. Falling back to direct mint.`);
    return attemptDirectMint(contractAddress, sourceWallet);
  }

  // ========== 4. Try quantities from highest to lowest ==========
  let success = false;

  for (const qty of quantityTries) {
    console.log(`[mint] Trying quantity ${qty} for ${slug}...`);

    let raw;
    try {
      raw = await buildDropMintTransaction(
        slug,
        DRY_RUN ? (WALLET_ADDRESS || ethers.ZeroAddress) : WALLET_ADDRESS,
        qty
      );
    } catch (err) {
      console.warn(`[opensea] quantity ${qty} failed to build: ${err.message}`);
      continue;
    }

    const { to, data, value } = readMintTxFields(raw);
    if (!to || !data) {
      console.warn(`[opensea] missing to/data for quantity ${qty}`);
      continue;
    }

    const valueWei = BigInt(value || '0');
    const valueEth = Number(ethers.formatEther(valueWei));

    // Price protection
    if (MAX_PRICE_ETH !== null && valueEth > MAX_PRICE_ETH) {
      console.warn(`[skip] ${slug} qty ${qty} costs ${valueEth} ETH > MAX_PRICE_ETH`);
      continue;
    }

    // Dry run mode
    if (DRY_RUN) {
      console.log(`[dry-run] Would mint ${qty} of ${slug} for ${valueEth} ETH`);
      await notify(
        `🧪 <b>Dry run</b>: would mint <b>${qty}</b> of <code>${escapeHtml(slug)}</code> for ${valueEth} ETH`
      );
      success = true;
      break;
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
        from: WALLET_ADDRESS,
      });
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      const totalCost = valueWei + gasEstimate * gasPrice;

      if (balance < totalCost) {
        console.warn(`[mint] Not enough balance for qty ${qty}`);
        continue;
      }

      const tx = await connectedSigner.sendTransaction({ to, data, value: valueWei });
      console.log(`[mint] Sent qty ${qty} → ${tx.hash}`);
      const receipt = await tx.wait();

      if (receipt.status === 1) {
        await notify(
          `✅ <b>Minted ${qty}</b> of <code>${escapeHtml(slug)}</code>\nTx: <code>${escapeHtml(tx.hash)}</code>`
        );
        success = true;
        break; // Stop after first successful mint
      } else {
        console.warn(`[mint] Quantity ${qty} reverted`);
      }
    } catch (err) {
      console.warn(`[mint] Quantity ${qty} failed: ${err.message}`);
      continue;
    }
  }

  if (!success) {
    console.error(`[mint] All quantity attempts failed for ${slug}`);
    await notify(
      `❌ Could not mint <code>${escapeHtml(slug)}</code><br>Tried quantities: ${quantityTries.join(', ')}`
    );
  }
}