<?php

/**
 * Internationalization.
 *
 * @since      1.0.0
 * @package    Plugin_Name
 * @subpackage Plugin_Name/includes
 * @author     The Rite Sites <theritesites@gmail.com>
 * @link       theritesites.com
 */
class Plugin_Name_i18n {

	/**
	 * The plugin slug, which is also the text domain.
	 *
	 * @since  1.0.0
	 * @access protected
	 * @var    string $slug
	 */
	protected $slug;

	/**
	 * @since 1.0.0
	 *
	 * @param string $slug The plugin slug and text domain.
	 */
	public function __construct( $slug ) {

		$this->slug = $slug;
	}

	/**
	 * Register this service's hooks.
	 *
	 * @since  1.0.0
	 * @return void
	 */
	public function register_hooks() {

		add_action( 'init', array( $this, 'load_plugin_textdomain' ) );
	}

	/**
	 * Load the translation files.
	 *
	 * Hooked to `init` rather than `plugins_loaded`: since WordPress 6.7 a
	 * translation loaded earlier than `init` triggers a `_doing_it_wrong`
	 * notice.
	 *
	 * The path is built from the slug constant rather than from
	 * `dirname( plugin_basename( __FILE__ ) )`, which the boilerplate used.
	 * That expression is evaluated inside `includes/` and therefore resolves to
	 * `<slug>/includes/languages/`, a directory no plugin in the suite has.
	 * The third argument is relative to WP_PLUGIN_DIR, and the installed
	 * directory name is the slug by definition here.
	 *
	 * @since  1.0.0
	 * @return void
	 */
	public function load_plugin_textdomain() {

		load_plugin_textdomain(
			$this->slug,
			false,
			PLUGIN_NAME_SLUG . '/languages/'
		);
	}
}
