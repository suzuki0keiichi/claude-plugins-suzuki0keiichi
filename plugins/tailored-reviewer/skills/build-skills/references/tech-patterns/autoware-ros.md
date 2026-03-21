# Autoware / ROS 2 — Tech-Specific Bug Patterns

## Execution Flow

- **Callback group executor starvation**: Default `SingleThreadedExecutor` processes callbacks sequentially. A blocking callback (heavy computation, synchronous I/O) starves all other callbacks including timer and subscription callbacks. Use `MultiThreadedExecutor` with `ReentrantCallbackGroup` for parallel callbacks, but then you need thread safety.
- **Timer drift**: `create_wall_timer(100ms, callback)` — if callback takes 80ms, the next invocation is at 100ms from START (not end). If callback takes >100ms, invocations pile up. Use wall timer for scheduling, measure actual elapsed time inside callback.
- **Service call deadlock in callback**: Calling a service synchronously (`client->call(request)`) inside a subscription callback blocks the executor. If the service handler is on the same executor, it can never execute = deadlock. Use async service calls or separate callback groups.
- **Transform (TF) lookup timing**: `tf_buffer->lookupTransform("map", "base_link", tf2::TimePointZero)` gets latest. But `lookupTransform("map", "base_link", msg->header.stamp)` waits for the exact timestamp. If TF for that stamp hasn't arrived yet, it blocks/throws. Use `canTransform` with timeout first.
- **QoS mismatch = silent no communication**: Publisher with `RELIABLE` QoS, subscriber with `BEST_EFFORT` — messages are NOT received. No error, no warning in logs. QoS profiles must be compatible. Use `rclcpp::SensorDataQoS()` for sensor data, `rclcpp::SystemDefaultsQoS()` for commands.
- **Lifecycle node state machine**: `LifecycleNode` must transition through `configure → activate` before processing. Publishing on an inactive node silently drops messages. Forgetting to activate after configure = silent data loss.

## Resource Management

- **Message allocation in real-time path**: `std::make_shared<sensor_msgs::msg::PointCloud2>()` allocates on heap. In real-time control loops (100Hz+), heap allocation causes latency spikes. Use pre-allocated messages or `rclcpp::PublisherOptions` with custom allocator.
- **Large message copies**: Passing `sensor_msgs::msg::PointCloud2` (can be >1MB) by value through ROS topics involves serialization + deserialization. Use `rclcpp::Publisher<T>::publish(std::unique_ptr<T>)` for zero-copy intra-process communication.
- **Point cloud memory**: `pcl::PointCloud` and `sensor_msgs::msg::PointCloud2` conversions (`pcl_conversions`) copy the entire cloud. For a 64-beam LiDAR at 10Hz, this is ~2MB × 10 × 2 (in + out) = 40MB/s of unnecessary copies.
- **TF buffer size**: Default TF buffer stores 10 seconds of transforms. If processing latency exceeds buffer size, transform lookups fail. Increase buffer duration for slow pipelines.
- **Bag file replay memory**: Playing back a large rosbag at maximum speed floods subscribers faster than they can process. Unbounded subscriber queues = memory exhaustion. Set `qos.depth` appropriately.

## Concurrency

- **Multi-threaded executor without mutex**: `MultiThreadedExecutor` calls callbacks concurrently. If two subscription callbacks share state (member variables), data races occur. Use `MutuallyExclusiveCallbackGroup` to serialize related callbacks, or add mutexes.
- **Shared state in component containers**: Multiple nodes in the same process (component container) share address space. Global/static variables in one component affect another. Isolate state in node member variables.
- **Timer and subscription race**: Timer callback reads `latest_msg_` while subscription callback writes it. Classic data race on member variable. Even `std::atomic` isn't sufficient for complex types — use `std::mutex`.
- **Non-deterministic message ordering**: Subscribers to multiple topics receive messages in arrival order, not timestamp order. Sensor fusion assuming synchronized input = incorrect results. Use `message_filters::TimeSynchronizer` or `ApproximateTimeSynchronizer`.

## Security

- **DDS discovery is network-wide**: ROS 2 DDS discovers all participants on the same network by default. No authentication. Any device on the same subnet can publish to any topic. Use `ROS_DOMAIN_ID` for basic isolation, SROS2 for encrypted communication.
- **Parameter server accepts remote changes**: `ros2 param set /node param value` from any machine on the network. A rogue parameter change (speed limit, safety threshold) = dangerous behavior. Use `ParameterCallbackHandle` to validate changes.
- **Diagnostic data exposure**: `/diagnostics` topic broadcasts system health including hardware errors, sensor status, internal state. Useful for debugging, but exposes system internals on the network.

## Platform Constraints

- **Real-time scheduling**: Autoware control loops targeting <1ms jitter need `SCHED_FIFO` or `SCHED_RR`. Default `SCHED_OTHER` gives no latency guarantees. Need `ulimit -r` or CAP_SYS_NICE capability.
- **ROS 2 DDS middleware choice**: Different DDS implementations (CycloneDDS, FastDDS, ConnextDDS) have different performance, resource usage, and QoS behavior. Switching DDS middleware can change timing behavior and break assumptions.
- **System time vs ROS time**: `this->now()` returns ROS time (can be sim time in simulation). `std::chrono::steady_clock::now()` is wall time. Mixing them in the same algorithm = incorrect duration calculations when sim time is slower/faster than real time.
- **Coordinate frame conventions**: Autoware uses `map` → `base_link` → `sensor_frame` chain. Missing intermediate frames (e.g., `base_link` → `velodyne`) cause transform lookup failures. Verify entire TF tree with `ros2 run tf2_tools view_frames`.

## Implementation Quality (Autoware-Specific)

- **Stale detection/tracking data**: Object tracking output with old timestamps mixed with new detections. Downstream planners act on outdated obstacle positions. Always check `header.stamp` freshness before using data.
- **Map frame assumption**: Autoware assumes operation in `map` frame (global coordinates). Components that accidentally operate in `base_link` frame produce results that rotate/translate with the vehicle.
- **Lanelet2 map loading**: Map loading is synchronous and can take seconds for large maps. If done in a callback, it blocks the executor. Load maps in `on_configure` lifecycle callback or in a separate thread.
- **Velocity/acceleration limits**: Control commands (`AckermannControlCommand`) should be clamped to vehicle physical limits. Missing clamp = commanding impossible accelerations, which low-level controllers may interpret unpredictably.
- **Diagnostic status not checked**: Components often publish diagnostics but planners don't subscribe. A sensor reporting ERROR continues feeding stale data to the pipeline. Subscribe to `/diagnostics` and degrade gracefully.
- **NDT/ICP localization divergence**: Point cloud matching can converge to wrong local minimum. If localization confidence (`transform_probability`) drops below threshold but no fallback engages, the vehicle operates with wrong position estimate.
- **`use_sim_time` mismatch across nodes**: Some nodes on sim time, others on wall time. TF lookups fail with "extrapolation into the future/past". Extremely hard to diagnose because the error message doesn't mention sim_time. Check ALL nodes' `use_sim_time` parameter.
- **Fast-RTPS service client recreation bug**: Re-creating a service client exactly 22 times without destroying causes the service to deadlock permanently. Known DDS middleware issue. Workaround: reuse clients or switch to CycloneDDS.
- **Remnant background nodes from crashed launch**: Crashed launch file leaves nodes running in background. Starting a new launch creates duplicate nodes (e.g., two localization nodes). Robot "jumps" on map due to conflicting updates. Always `killall` or check `ros2 node list` before relaunch.
- **`waitForTransform` with TimeStampZero bug**: Using `tf2::TimeStampZero` with `waitForTransform` shows "ready" status but `get()` throws exception. Known tf2 bug. Use a small timeout and check result validity.
- **ROS 2 message header field naming change from ROS 1**: `Header header` in message definitions must be `std_msgs/Header header` in ROS 2. Missing this causes cryptic "No such file or directory" compile errors on the generated `__struct.hpp`.
- **`shared_ptr` double-free in ROS 1→2 port**: When porting, if constructor takes a dereferenced shared pointer and creates a new shared_ptr from it, both shared_ptrs think they own the object = double-free on destruction.
