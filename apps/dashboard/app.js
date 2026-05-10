const GODEYE_ADDRESS = "0x46b3962e8620fada92df1e36d2e7eadd6dcc6484";
const SIGNAL_TOKEN_ADDRESS = "0x6175e3016761f8fb7efff23b05fc7249055b1ea1";

const GODEYE_ABI = [
    "function getDeviceInfo(address _device) view returns (bool, string, uint256, uint256)",
    "event ProofSubmitted(address indexed device, uint256 jobId, bytes32 merkleRoot, uint256 reward)"
];

const SIGNAL_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function symbol() view returns (string)"
];

async function init() {
    if (typeof window.ethereum !== 'undefined') {
        const provider = new ethers.providers.Web3Provider(window.ethereum);
        
        try {
            const accounts = await provider.send("eth_requestAccounts", []);
            const userAddress = accounts[0];
            document.getElementById('wallet-address').innerText = `${userAddress.substring(0,6)}...${userAddress.substring(38)}`;
            
            const signalContract = new ethers.Contract(SIGNAL_TOKEN_ADDRESS, SIGNAL_ABI, provider);
            const balance = await signalContract.balanceOf(userAddress);
            document.getElementById('total-rewards').innerText = ethers.utils.formatEther(balance);

            const godEyeContract = new ethers.Contract(GODEYE_ADDRESS, GODEYE_ABI, provider);
            const deviceInfo = await godEyeContract.getDeviceInfo(userAddress);
            
            if (deviceInfo[0]) {
                document.getElementById('device-count').innerText = "1";
                // Update subtext if ENS is available
            }

            // Listen for events
            godEyeContract.on("ProofSubmitted", (device, jobId, merkleRoot, reward) => {
                if (device.toLowerCase() === userAddress.toLowerCase()) {
                    addProofToFeed(jobId, merkleRoot, reward);
                    updateBalance(userAddress, signalContract);
                }
            });

        } catch (err) {
            console.error("User denied account access", err);
        }
    } else {
        alert("Please install MetaMask to use the GodEye Dashboard!");
    }
}

function addProofToFeed(jobId, merkleRoot, reward) {
    const feed = document.getElementById('proof-feed');
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.innerHTML = `
        <div class="item-header">
            <span class="batch-id">Batch #${jobId}</span>
            <span class="timestamp">Just now</span>
        </div>
        <div class="item-content">
            <p>ZK-Proof verified. Reward: +${ethers.utils.formatEther(reward)} SIGNAL</p>
            <div class="swarm-link">Root: <code>${merkleRoot}</code></div>
        </div>
        <div class="item-footer">
            <span class="status-badge settled">On-Chain Settled</span>
        </div>
    `;
    feed.prepend(item);
}

async function updateBalance(address, contract) {
    const balance = await contract.balanceOf(address);
    document.getElementById('total-rewards').innerText = ethers.utils.formatEther(balance);
}

window.addEventListener('load', init);
