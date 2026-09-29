<?php
/**
 * PDM Dhru API Test Client
 * Based on official Dhru Fusion API v2.0 specification
 * Tests compatibility with actual Dhru panel integration
 */

// Configuration - Update with your actual credentials
define("REQUESTFORMAT", "JSON");
define('DHRUFUSION_URL', "http://localhost:3000");
define("USERNAME", "distributor");
define("API_ACCESS_KEY", "8B3-B92-97F-40E-E17-BA9-B49-78C");

class DhruFusionTestClient
{
    var $xmlData;
    var $debug;
    
    function __construct()
    {
        $this->xmlData = new DOMDocument();
        $this->debug = true;
    }
    
    function action($action, $arr = array())
    {
        if (is_string($action))
        {
            if (is_array($arr))
            {
                if (count($arr))
                {
                    $request = $this->xmlData->createElement("PARAMETERS");
                    $this->xmlData->appendChild($request);
                    foreach ($arr as $key => $val)
                    {
                        $key = strtoupper($key);
                        $request->appendChild($this->xmlData->createElement($key, $val));
                    }
                }
                
                $posted = array(
                    'username' => USERNAME,
                    'apiaccesskey' => API_ACCESS_KEY,
                    'action' => $action,
                    'requestformat' => REQUESTFORMAT,
                    'parameters' => $this->xmlData->saveHTML()
                );
                
                $curl = curl_init();
                curl_setopt($curl, CURLOPT_HEADER, false);
                curl_setopt($curl, CURLOPT_USERAGENT, $_SERVER['HTTP_USER_AGENT'] ?? 'PDM-Test-Client/1.0');
                curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
                curl_setopt($curl, CURLOPT_URL, DHRUFUSION_URL . '/api/dhru/index.php');
                curl_setopt($curl, CURLOPT_POST, true);
                curl_setopt($curl, CURLOPT_SSL_VERIFYPEER, false);
                curl_setopt($curl, CURLOPT_POSTFIELDS, $posted);
                
                $response = curl_exec($curl);
                
                if (curl_errno($curl) != CURLE_OK)
                {
                    echo "cURL Error: " . curl_error($curl) . "\n";
                    curl_close($curl);
                    return false;
                }
                else
                {
                    curl_close($curl);
                    
                    if ($this->debug)
                    {
                        echo "Raw Response:\n";
                        echo str_repeat("=", 80) . "\n";
                        echo $response . "\n";
                        echo str_repeat("=", 80) . "\n\n";
                    }
                    
                    return json_decode($response, true);
                }
            }
        }
        return false;
    }
}

// Test Functions
function testAccountInfo($api)
{
    echo "\n" . str_repeat("=", 80) . "\n";
    echo "TEST 1: Account Info (accountinfo)\n";
    echo str_repeat("=", 80) . "\n";
    
    $request = $api->action('accountinfo');
    
    echo "Response:\n";
    print_r($request);
    
    if ($request && $request['STATUS'] === 'SUCCESS')
    {
        echo "\n✓ SUCCESS - Balance: {$request['CREDITS']} credits\n";
        return true;
    }
    else
    {
        echo "\n✗ FAILED\n";
        return false;
    }
}

function testServiceList($api)
{
    echo "\n" . str_repeat("=", 80) . "\n";
    echo "TEST 2: Service List (imeiservicelist)\n";
    echo str_repeat("=", 80) . "\n";
    
    $request = $api->action('imeiservicelist');
    
    echo "Response:\n";
    print_r($request);
    
    if ($request && $request['STATUS'] === 'SUCCESS')
    {
        echo "\n✓ SUCCESS - Found {$request['TOTAL']} services\n";
        return $request['SERVICES'] ?? [];
    }
    else
    {
        echo "\n✗ FAILED\n";
        return [];
    }
}

function testPlaceOrder($api)
{
    echo "\n" . str_repeat("=", 80) . "\n";
    echo "TEST 3: Place Order (placeimeiorder)\n";
    echo str_repeat("=", 80) . "\n";
    
    $params = array(
        'IMEI' => 'testuser@example.com',
        'ID' => 'PDM3M' // 3 Month License
    );
    
    echo "Order Parameters:\n";
    print_r($params);
    echo "\n";
    
    $request = $api->action('placeimeiorder', $params);
    
    echo "Response:\n";
    print_r($request);
    
    if ($request && $request['STATUS'] === 'SUCCESS')
    {
        echo "\n✓ SUCCESS - Order ID: {$request['REFERENCEID']}\n";
        echo "License Key: {$request['CODE']}\n";
        return $request['REFERENCEID'];
    }
    else
    {
        echo "\n✗ FAILED";
        if (isset($request['ERROR']))
        {
            echo " - Error: {$request['ERROR']} - {$request['MESSAGE']}\n";
        }
        else
        {
            echo "\n";
        }
        return null;
    }
}

function testOrderDetails($api, $orderId)
{
    echo "\n" . str_repeat("=", 80) . "\n";
    echo "TEST 4: Get Order Details (getimeiorder)\n";
    echo str_repeat("=", 80) . "\n";
    
    if (!$orderId)
    {
        echo "⚠ Skipping - No order ID from previous test\n";
        return false;
    }
    
    $params = array('ID' => $orderId);
    
    echo "Query Parameters:\n";
    print_r($params);
    echo "\n";
    
    $request = $api->action('getimeiorder', $params);
    
    echo "Response:\n";
    print_r($request);
    
    if ($request && $request['STATUS'] === 'SUCCESS')
    {
        echo "\n✓ SUCCESS - License Key: {$request['CODE']}\n";
        return true;
    }
    else
    {
        echo "\n✗ FAILED\n";
        return false;
    }
}

// Main Test Execution
echo str_repeat("=", 80) . "\n";
echo "PDM DHRU API COMPATIBILITY TEST\n";
echo str_repeat("=", 80) . "\n";
echo "Endpoint: " . DHRUFUSION_URL . "/api/dhru/index.php\n";
echo "Username: " . USERNAME . "\n";
echo "API Key: " . API_ACCESS_KEY . "\n";

$api = new DhruFusionTestClient();
$api->debug = true;

$testsPassed = 0;
$testsFailed = 0;

// Test 1: Account Info
if (testAccountInfo($api)) {
    $testsPassed++;
} else {
    $testsFailed++;
}

// Test 2: Service List
$services = testServiceList($api);
if (!empty($services)) {
    $testsPassed++;
} else {
    $testsFailed++;
}

// Test 3: Place Order (only if balance is sufficient)
$orderId = testPlaceOrder($api);
if ($orderId) {
    $testsPassed++;
} else {
    $testsFailed++;
}

// Test 4: Order Details
if (testOrderDetails($api, $orderId)) {
    $testsPassed++;
} else {
    $testsFailed++;
}

// Summary
echo "\n" . str_repeat("=", 80) . "\n";
echo "TEST SUMMARY\n";
echo str_repeat("=", 80) . "\n";
echo "Passed: $testsPassed\n";
echo "Failed: $testsFailed\n";
echo "\n";

if ($testsFailed === 0) {
    echo "✓ ALL TESTS PASSED - API is fully compatible with Dhru Fusion!\n";
    exit(0);
} else {
    echo "✗ SOME TESTS FAILED - Check errors above\n";
    exit(1);
}

?>
