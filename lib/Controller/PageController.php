<?php
namespace OCA\Screenplay\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\IRequest;

class PageController extends Controller {
    public function __construct(IRequest $request) {
        parent::__construct('screenplay', $request);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function index(): TemplateResponse {
        $response = new TemplateResponse('screenplay', 'index');
        
        // Add CSP to allow custom app scripts
        $policy = new ContentSecurityPolicy();
        $policy->addAllowedScriptDomain("'self'");
        $policy->addAllowedScriptDomain("'unsafe-inline'");
        $response->setContentSecurityPolicy($policy);
        
        return $response;
    }
}
