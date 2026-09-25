<?php
namespace mod_drmx\privacy;
defined('MOODLE_INTERNAL') || die();
class provider implements \core_privacy\local\metadata\provider {
    public static function get_metadata(\core_privacy\local\metadata\collection $collection): \core_privacy\local\metadata\collection {
        return $collection->add_external_location_link('drmx', ['subject' => 'privacy:metadata:drmx:subject',
            'contentId' => 'privacy:metadata:drmx:contentId', 'platformCapabilities' => 'privacy:metadata:drmx:platformCapabilities'], 'privacy:metadata:drmx');
    }
}
