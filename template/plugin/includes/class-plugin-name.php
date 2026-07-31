<?php

/**
 * The core plugin class.
 *
 * Holds the plugin identity, loads the services, and lets each service
 * register its own hooks.
 *
 * WHY THERE IS NO LOADER CLASS HERE
 * ---------------------------------------------------------------------------
 * The WordPress Plugin Boilerplate collects every hook into a loader object
 * and registers them in one pass. That was worth it when hooks were declared
 * far from the code that services them, which was a consequence of the
 * admin/public split this template also drops. With each service registering
 * its own hooks in `register_hooks()`, the loader is an extra indirection that
 * hides the connection between a hook and its callback. Read the service, see
 * its hooks.
 *
 * @since      1.0.0
 * @package    Plugin_Name
 * @subpackage Plugin_Name/includes
 * @author     The Rite Sites <theritesites@gmail.com>
 * @link       theritesites.com
 */
class Plugin_Name {

	/**
	 * The plugin slug, used as the text domain and asset handle prefix.
	 *
	 * @since  1.0.0
	 * @access protected
	 * @var    string $slug
	 */
	protected $slug;

	/**
	 * The current version of the plugin.
	 *
	 * @since  1.0.0
	 * @access protected
	 * @var    string $version
	 */
	protected $version;

	/**
	 * Define the plugin identity.
	 *
	 * @since 1.0.0
	 */
	public function __construct() {

		$this->slug    = PLUGIN_NAME_SLUG;
		$this->version = PLUGIN_NAME_VERSION;
	}

	/**
	 * Register every hook the plugin needs.
	 *
	 * Add a service by requiring it above, constructing it here, and calling
	 * its own `register_hooks()`. Nothing else in the plugin should call
	 * `add_action` or `add_filter` at file scope.
	 *
	 * @since  1.0.0
	 * @return void
	 */
	public function run() {

		$i18n = new Plugin_Name_i18n( $this->slug );
		$i18n->register_hooks();
	}

	/**
	 * The plugin slug.
	 *
	 * @since  1.0.0
	 * @return string
	 */
	public function get_slug() {

		return $this->slug;
	}

	/**
	 * The plugin version.
	 *
	 * @since  1.0.0
	 * @return string
	 */
	public function get_version() {

		return $this->version;
	}
}
