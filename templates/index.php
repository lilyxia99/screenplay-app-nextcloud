<?php
style('screenplay', 'screenplay-main');
$nonce = \OC::$server->getContentSecurityPolicyNonceManager()->getNonce();
$user  = \OC::$server->getUserSession()->getUser()->getUID();
?>
<script nonce="<?php p($nonce); ?>">
window._SP_USER = '<?php p($user); ?>';
<?php echo file_get_contents(__DIR__ . '/../js/screenplay-main.js'); ?>
</script>
<div id="screenplay-root" style="width:100%;height:100%;position:fixed;top:50px;left:0;right:0;bottom:0;background:#1e1e2e;">
  <div id="app-content-vue"></div>
</div>
