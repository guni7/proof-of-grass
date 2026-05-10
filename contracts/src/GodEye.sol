// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SignalToken.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract GodEye is Ownable {
    SignalToken public immutable token;
    uint256 public constant UPTIME_WINDOW = 5 minutes;
    uint256 public constant REWARD_PER_BATCH = 10 * 10**18;

    struct Device {
        bool registered;
        string ensSubname;
        uint256 lastSeen;
        uint256 totalRewards;
    }

    mapping(address => Device) public devices;
    mapping(uint256 => bool) public processedJobs;

    event DeviceRegistered(address indexed device, string ensSubname);
    event ProofSubmitted(address indexed device, uint256 jobId, bytes32 merkleRoot, uint256 reward);

    constructor(address _token) Ownable(msg.sender) {
        token = SignalToken(_token);
    }

    function registerDevice(address _device, string calldata _ensSubname) external onlyOwner {
        devices[_device] = Device({
            registered: true,
            ensSubname: _ensSubname,
            lastSeen: block.timestamp,
            totalRewards: 0
        });
        emit DeviceRegistered(_device, _ensSubname);
    }

    function submitProof(uint256 _jobId, bytes32 _merkleRoot) external {
        Device storage device = devices[msg.sender];
        require(device.registered, "Device not registered");
        require(!processedJobs[_jobId], "Job already processed");

        uint256 timeSinceLast = block.timestamp - device.lastSeen;
        uint256 reward = REWARD_PER_BATCH;

        if (timeSinceLast > UPTIME_WINDOW) {
            uint256 penalty = (timeSinceLast / UPTIME_WINDOW) * 2 * 10**18;
            if (penalty >= reward) reward = 1 * 10**18;
            else reward -= penalty;
        }

        device.lastSeen = block.timestamp;
        device.totalRewards += reward;
        processedJobs[_jobId] = true;
        token.mint(msg.sender, reward);
        emit ProofSubmitted(msg.sender, _jobId, _merkleRoot, reward);
    }

    function getDeviceInfo(address _device) external view returns (bool, string memory, uint256, uint256) {
        Device memory d = devices[_device];
        return (d.registered, d.ensSubname, d.lastSeen, d.totalRewards);
    }
}
